import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentEvent, TaskPermissions } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import {
  evaluate,
  type Decision,
  type PermissionLevel,
  type Policy,
} from "@agent-studio/policy-engine";
import type { Logger } from "@agent-studio/shared-utils";
import type { Repo } from "@agent-studio/storage";
import type { ApprovalService } from "./approvals.js";

export interface GateWorkspaces {
  status(path: string): Promise<{ files: { path: string; code: string }[] }>;
}

export interface PolicyGateOptions {
  repo: Repo;
  /** Lazy: the gate is built before the approval service and the workspaces exist. */
  approvals: () => ApprovalService;
  workspaces: () => GateWorkspaces;
  /**
   * Programs an agent may be launched as: its default name and the stored, probed command. Anything else the
   * adapter reports in `describeLaunch` needs a person's approval.
   */
  allowedCommands: (agentId: string) => readonly string[];
  log: Logger;
  /** Masks secret values in text that is stored or shown (approval cards, reasons). Default: identity. */
  redact?: (text: string) => string;
  /** Test seam. The real `evaluate` never throws; this is how "the engine failed" is tested. */
  evaluate?: typeof evaluate;
  /** How often a waiting gate looks at the task state. Default 200 ms. */
  pollMs?: number;
}

/** What a task's permissions mean for the policy. No permissions = the adapter default, treated as workspace write. */
export function levelFor(permissions: TaskPermissions | undefined): PermissionLevel {
  return permissions === "read-only" ? "read_only" : "workspace_write";
}

type Stop = { stop: true; message: string };
const stopWith = (message: string): Stop => ({ stop: true, message });
const isStop = (v: unknown): v is Stop => typeof v === "object" && v !== null && "stop" in v;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Content hash of every changed path; a file that cannot be read (deleted, a directory) is recorded as such. */
type Snapshot = Map<string, string>;

/**
 * Policy Engine gate around one adapter (Phase 4, P4-1 a + b).
 *
 * BEFORE the adapter starts anything: project root, working directory (project root or one of the workflow's
 * worktrees) and the program the adapter says it will launch are each put to `evaluate()`. Fail-closed: a deny, an
 * engine error or any unexpected throw means `inner.execute` is never called. An `ask` creates an approval through
 * the production `ApprovalService` and the run waits for the answer.
 *
 * AFTER the run: the worktree is compared with the snapshot taken before. A change the grant does not cover (any
 * change on a read-only task, a protected path, a file the CLI reported as denied) turns the outcome into
 * `needs_reconciliation`; nothing retries it. It is detection after the fact, not prevention, and it sees only
 * what a git status sees.
 *
 * It is NOT a sandbox and does not watch what a CLI does inside its own loop (sandbox-free, ADR-002; hướng (c)/(d)
 * of P4-1 need probes that have not been run).
 */
export class PolicyGate {
  private readonly evaluate: typeof evaluate;
  private readonly pollMs: number;
  private readonly redact: (text: string) => string;

  constructor(private readonly opts: PolicyGateOptions) {
    this.evaluate = opts.evaluate ?? evaluate;
    this.pollMs = opts.pollMs ?? 200;
    this.redact = opts.redact ?? ((t) => t);
  }

  /** `stub` is the internal Phase 0 fixture; spike projects have no real folder. Both are explicit exemptions. */
  wrap(inner: AgentAdapter, o: { checkLaunch?: boolean } = {}): AgentAdapter {
    if (inner.id === "stub") return inner;
    const wrapped: AgentAdapter = {
      get id() {
        return inner.id;
      },
      detect: () => inner.detect(),
      capabilities: () => inner.capabilities(),
      cancel: (taskId) => inner.cancel(taskId),
      execute: (task) => this.run(inner, task, o.checkLaunch !== false),
    };
    // Same program and argv as `execute` would use, so a caller (or a test) can see exactly what was checked.
    if (inner.describeLaunch) wrapped.describeLaunch = (t) => inner.describeLaunch!(t);
    return wrapped;
  }

  private async *run(
    inner: AgentAdapter,
    task: AgentTask,
    checkLaunch: boolean,
  ): AsyncGenerator<AgentEvent> {
    let before: Snapshot | undefined;
    try {
      const pre = await this.preflight(inner, task, checkLaunch);
      if (isStop(pre)) {
        yield { type: "error", message: pre.message };
        return;
      }
      before = pre.baseline;
    } catch (err) {
      // Fail closed: whatever went wrong, nothing is started.
      this.opts.log.error({ taskId: task.id, err: this.redact(String(err)) }, "policy gate failed");
      yield { type: "error", message: "policy gate failed (denied, fail-closed)" };
      return;
    }

    const denials: Extract<AgentEvent, { type: "permission_denied" }>[] = [];
    let terminal: AgentEvent | undefined;
    for await (const event of inner.execute(task)) {
      if (event.type === "permission_denied") denials.push(event);
      if (event.type === "completed" || event.type === "error") {
        terminal = event; // held back until the worktree has been checked
        break; // nothing after the terminal event is forwarded; leaving the loop closes the adapter
      }
      yield event;
    }

    const problem = before ? await this.postcheck(task, before, denials) : undefined;
    if (problem !== undefined) {
      yield { type: "error", message: this.redact(problem), needsReconciliation: true };
    } else if (terminal) {
      yield terminal;
    }
  }

  // ---- before the run -----------------------------------------------------------------------------------------

  private async preflight(
    inner: AgentAdapter,
    task: AgentTask,
    checkLaunch: boolean,
  ): Promise<Stop | { baseline: Snapshot | undefined }> {
    const { repo } = this.opts;
    const row = repo.getTask(task.id);
    if (!row) return stopWith("policy denied: unknown task");
    const root = repo.getWorkflowRoot(row.workflowId);
    if (!root) return stopWith("policy denied: the workflow has no project root");
    if (root.rootPath.startsWith("spike://")) return { baseline: undefined }; // Phase 0 spike project

    const level = levelFor(task.permissions);
    const write = level !== "read_only";

    // 1. Project root.
    const rootDecision = await this.evaluate(
      { level, workspaceRoot: root.rootPath },
      { kind: "fs.read", path: root.rootPath },
      { taskId: task.id },
    );
    const rootStop = await this.settle(task, rootDecision, `Use project folder ${root.rootPath}`);
    if (rootStop) return rootStop;

    // 2. Working directory: the project root or one of this workflow's worktrees.
    const bases = [root.rootPath, ...repo.listWorktrees(row.workflowId).map((w) => w.path)];
    let cwdDecision: Decision | undefined;
    for (const base of bases) {
      const policy: Policy = { level, workspaceRoot: base };
      const d = await this.evaluate(
        policy,
        { kind: write ? "fs.write" : "fs.read", path: task.cwd },
        { taskId: task.id },
      );
      if (d.effect === "allow") {
        cwdDecision = d;
        break;
      }
      cwdDecision ??= d;
    }
    if (cwdDecision?.effect !== "allow") {
      const stop = await this.settle(
        task,
        cwdDecision ?? {
          effect: "deny",
          code: "outside_scope",
          reason: "No folder to check against.",
        },
        `Work in ${task.cwd}`,
      );
      if (stop) return stop;
    }

    // 3. The program and argument list the adapter is about to start.
    const launch = checkLaunch ? inner.describeLaunch?.(task) : undefined;
    if (launch) {
      const allow = [...new Set(this.opts.allowedCommands(inner.id))].map((e) => ({
        executable: e,
      }));
      const d = await this.evaluate(
        { level: "restricted_tools", workspaceRoot: task.cwd, commands: { allow } },
        { kind: "command", executable: launch.command, args: launch.args },
        { taskId: task.id },
      );
      const shown = launch.args.map((a) => clip(a, 40)).join(" ");
      const stop = await this.settle(
        task,
        d,
        `Start ${launch.command} ${shown} in ${task.cwd} (agent ${inner.id})`,
      );
      if (stop) return stop;
    }

    // 4. Baseline for the check after the run. A folder git cannot describe is not checked (reported limit).
    let baseline: Snapshot | undefined;
    try {
      baseline = await this.snapshot(task.cwd);
    } catch (err) {
      this.opts.log.warn(
        { taskId: task.id, err: this.redact(String(err)) },
        "no worktree baseline; the run will not be checked afterwards",
      );
    }
    return { baseline };
  }

  /** `undefined` = go on. A deny stops; an ask creates an approval and waits for the person. */
  private async settle(
    task: AgentTask,
    decision: Decision,
    what: string,
  ): Promise<Stop | undefined> {
    if (decision.effect === "allow") return undefined;
    if (decision.effect === "deny") {
      return stopWith(`policy denied (${decision.code}): ${decision.reason}`);
    }
    const description = this.redact(
      `${what} — ${decision.reason} [${decision.code}: ${decision.target}]`,
    );
    this.opts.approvals().request(task.id, description);
    for (;;) {
      if (task.signal.aborted) return stopWith("cancelled");
      const state = this.opts.repo.getTaskState(task.id);
      if (state === "running") return undefined; // approved
      if (state !== "waiting_approval") {
        return stopWith(`policy: approval not granted (task is ${String(state)})`);
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  // ---- after the run ------------------------------------------------------------------------------------------

  private async snapshot(cwd: string): Promise<Snapshot> {
    const out: Snapshot = new Map();
    for (const f of (await this.opts.workspaces().status(cwd)).files) {
      let digest: string;
      try {
        digest = createHash("sha256")
          .update(readFileSync(join(cwd, f.path)))
          .digest("hex");
      } catch {
        digest = "unreadable"; // deleted, or a directory
      }
      out.set(f.path, digest);
    }
    return out;
  }

  /** Why the run cannot be trusted, or `undefined`. Never throws: a failed check is itself a problem. */
  private async postcheck(
    task: AgentTask,
    before: Snapshot,
    denials: readonly Extract<AgentEvent, { type: "permission_denied" }>[],
  ): Promise<string | undefined> {
    try {
      const after = await this.snapshot(task.cwd);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
        (p) => before.get(p) !== after.get(p),
      );
      if (changed.length === 0) return undefined;

      const policy: Policy = { level: levelFor(task.permissions), workspaceRoot: task.cwd };
      const found: string[] = [];
      for (const p of changed) {
        const d = await this.evaluate(
          policy,
          { kind: "fs.write", path: join(task.cwd, p) },
          { taskId: task.id },
        );
        if (d.effect !== "allow")
          found.push(`${p}: ${d.effect === "deny" ? d.reason : `needs approval (${d.reason})`}`);
      }
      // The CLI said it refused this write, yet the file changed: the report cannot be believed.
      const denied = new Set(denials.map((d) => deniedPath(d.input, task.cwd)).filter(isString));
      for (const p of changed) {
        if (denied.has(resolve(task.cwd, p).toLowerCase())) {
          found.push(`${p}: the CLI reported this write as denied, but the file changed`);
        }
      }
      if (found.length === 0) return undefined;
      const shown = found.slice(0, 5).join("; ");
      return `changes outside the granted scope (${found.length}): ${shown}${found.length > 5 ? "; …" : ""}; side effects need review`;
    } catch (err) {
      this.opts.log.error(
        { taskId: task.id, err: this.redact(String(err)) },
        "post-run check failed",
      );
      return "could not verify the worktree after the run; side effects unverified";
    }
  }
}

const isString = (v: unknown): v is string => typeof v === "string";

/** The file a denied tool use pointed at (`file_path` / `path` / `notebook_path`), lower-cased for comparison. */
function deniedPath(input: unknown, cwd: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const raw = [o["file_path"], o["path"], o["notebook_path"]].find(isString);
  if (raw === undefined || raw === "") return undefined;
  return (isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)).toLowerCase();
}
