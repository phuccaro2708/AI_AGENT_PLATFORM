import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { AdapterRegistry, type AgentAdapter, type AgentTask } from "@agent-studio/agent-core";
import type { AgentEvent, TaskPermissions } from "@agent-studio/contracts";
import { evaluate } from "@agent-studio/policy-engine";
import { createLogger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo } from "@agent-studio/storage";
import { ApprovalService } from "./approvals.js";
import { Orchestrator } from "./orchestrator.js";
import { PolicyGate, levelFor } from "./policy-gate.js";
import { ProjectWorkspaces } from "./workspaces.js";

const quiet = createLogger({
  name: "t",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Runs a script instead of a CLI: counts how often it was started and can touch files. */
class Scripted implements AgentAdapter {
  executed = 0;
  constructor(
    readonly id: string,
    private readonly script: (task: AgentTask) => AgentEvent[] | Promise<AgentEvent[]> = () => [],
    launch?: { command: string; args: readonly string[] },
  ) {
    if (launch) this.describeLaunch = () => launch;
  }
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  describeLaunch?: () => { command: string; args: readonly string[] };
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    this.executed++;
    for (const e of await this.script(task)) yield e;
    yield { type: "completed" };
  }
}

let dir: string;
let root: string;
let db: ReturnType<typeof openDatabase>;
let repo: Repo;
let workflowId: string;
let orchestrator: Orchestrator;
let registry: AdapterRegistry;
let approvals: ApprovalService;

function open(
  adapter: AgentAdapter,
  gateOpts: Partial<ConstructorParameters<typeof PolicyGate>[0]> = {},
) {
  const workspaces = new ProjectWorkspaces(repo, join(dir, "wt"));
  const gate = new PolicyGate({
    repo,
    log: quiet,
    approvals: () => approvals,
    workspaces: () => workspaces,
    allowedCommands: () => [],
    pollMs: 10,
    ...gateOpts,
  });
  registry.register(gate.wrap(adapter));
}

/** A queued task executed the way the scheduler does: claimed as `running`, then `execute`. */
async function runTask(agentId: string, permissions: TaskPermissions | undefined, cwd = root) {
  const taskId = orchestrator.enqueue({
    workflowId,
    agentId,
    prompt: "do it",
    cwd,
    ...(permissions ? { permissions } : {}),
  });
  repo.setTaskState(taskId, "running");
  const result = await orchestrator.execute(taskId);
  return { taskId, result };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-gate-"));
  root = join(dir, "project");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  db = openDatabase(join(dir, "s.db"));
  runMigrations(db);
  repo = new Repo(db);
  workflowId = repo.createWorkflow(repo.createProject("p", root));
  registry = new AdapterRegistry();
  orchestrator = new Orchestrator(registry, repo, quiet);
  approvals = new ApprovalService({ repo });
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("pre-run gate (P4-1a)", () => {
  it("maps task permissions to a level; no permissions is workspace write", () => {
    expect(levelFor("read-only")).toBe("read_only");
    expect(levelFor("workspace-write")).toBe("workspace_write");
    expect(levelFor(undefined)).toBe("workspace_write");
  });

  it("lets a task in the project folder run", async () => {
    const a = new Scripted("ok");
    open(a);
    const { result } = await runTask("ok", "workspace-write");
    expect(result.finalState).toBe("completed");
    expect(a.executed).toBe(1);
  });

  it("deny: nothing is started and the task fails with the policy's reason", async () => {
    const a = new Scripted("a");
    open(a, {
      evaluate: async () => ({ effect: "deny", code: "rule_deny", reason: "nope" }),
    });
    const { result } = await runTask("a", "workspace-write");
    expect(a.executed).toBe(0);
    expect(result.finalState).toBe("failed");
    expect(result.reason).toContain("policy denied (rule_deny): nope");
  });

  it("the engine throwing is a deny (fail-closed): nothing is started", async () => {
    const a = new Scripted("a");
    open(a, {
      evaluate: () => Promise.reject(new Error("engine blew up")),
    });
    const { result } = await runTask("a", "workspace-write");
    expect(a.executed).toBe(0);
    expect(result.finalState).toBe("failed");
    expect(result.reason).toContain("fail-closed");
    expect(result.reason).not.toContain("blew up");
  });

  it("a working directory outside the project and its worktrees is denied by the real engine", async () => {
    const outside = join(dir, "elsewhere");
    mkdirSync(outside);
    const a = new Scripted("a");
    open(a);
    const { result } = await runTask("a", "workspace-write", outside);
    expect(a.executed).toBe(0);
    expect(result.finalState).toBe("failed");
    expect(result.reason).toContain("outside_scope");
  });

  it("a project folder that no longer exists is denied", async () => {
    rmSync(root, { recursive: true, force: true });
    const a = new Scripted("a");
    open(a);
    const { result } = await runTask("a", "read-only");
    expect(a.executed).toBe(0);
    expect(result.reason).toContain("workspace_unavailable");
  });

  it("a shell as the launched program is denied, not asked", async () => {
    const a = new Scripted("a", () => [], { command: "powershell.exe", args: ["-c", "x"] });
    open(a, { allowedCommands: () => ["powershell.exe"] });
    const { result } = await runTask("a", "workspace-write");
    expect(a.executed).toBe(0);
    expect(result.reason).toContain("interpreter");
    expect(repo.listApprovals("pending")).toEqual([]);
  });

  it("a declared program is allowed without asking", async () => {
    const a = new Scripted("a", () => [], { command: "mytool", args: ["--go"] });
    open(a, { allowedCommands: () => ["mytool"] });
    const { result } = await runTask("a", "workspace-write");
    expect(result.finalState).toBe("completed");
    expect(a.executed).toBe(1);
    expect(repo.listApprovals("pending")).toEqual([]);
  });

  it("ask: an approval is created through the production service, and approving lets the run start", async () => {
    const a = new Scripted("a", () => [], { command: "unlisted-tool", args: ["--flag"] });
    open(a);
    const running = runTask("a", "workspace-write");
    const pending = await waitForPending();
    expect(pending.requestJson).toContain("unlisted-tool --flag");
    expect(JSON.parse(pending.requestJson).description).toContain(root);
    expect(a.executed).toBe(0);
    expect(repo.getTaskState(pending.taskId)).toBe("waiting_approval");
    approvals.resolve(pending.id, "approved");
    const { result } = await running;
    expect(a.executed).toBe(1);
    expect(result.finalState).toBe("completed");
  });

  it("ask: denying the approval fails the task and nothing is started", async () => {
    const a = new Scripted("a", () => [], { command: "unlisted-tool", args: [] });
    open(a);
    const running = runTask("a", "workspace-write");
    const pending = await waitForPending();
    approvals.resolve(pending.id, "denied", "no");
    const { taskId, result } = await running;
    expect(a.executed).toBe(0);
    expect(result.finalState).toBe("failed");
    expect(repo.getTaskState(taskId)).toBe("failed");
  });

  it("ask: an approval nobody answers expires into needs_reconciliation and nothing is started", async () => {
    const a = new Scripted("a", () => [], { command: "unlisted-tool", args: [] });
    approvals = new ApprovalService({ repo, defaultTtlMs: -1 }); // already overdue
    open(a);
    const running = runTask("a", "workspace-write");
    await waitForPending();
    approvals.expireDue();
    const { result } = await running;
    expect(a.executed).toBe(0);
    expect(result.finalState).toBe("needs_reconciliation");
  });

  it("ask: cancelling while the approval is open stops the wait", async () => {
    const a = new Scripted("a", () => [], { command: "unlisted-tool", args: [] });
    open(a);
    const ac = new AbortController();
    const taskId = orchestrator.enqueue({ workflowId, agentId: "a", prompt: "p", cwd: root });
    repo.setTaskState(taskId, "running");
    const running = orchestrator.execute(taskId, { signal: ac.signal });
    await waitForPending();
    ac.abort();
    const result = await running;
    expect(a.executed).toBe(0);
    expect(result.finalState).toBe("cancelled");
  });

  it("the real engine is what decides: it is called for the folder and for the launch", async () => {
    const seen: string[] = [];
    const a = new Scripted("a", () => [], { command: "mytool", args: [] });
    open(a, {
      allowedCommands: () => ["mytool"],
      evaluate: (policy, request, ctx) => {
        seen.push(request.kind);
        return evaluate(policy, request, ctx);
      },
    });
    await runTask("a", "workspace-write");
    expect(seen).toEqual(["fs.read", "fs.write", "command"]);
  });
});

describe("post-run check (P4-1b)", () => {
  it("a read-only task that changes a file ends in needs_reconciliation and is not retried", async () => {
    const a = new Scripted("w", (t) => {
      writeFileSync(join(t.cwd, "sneaky.txt"), "x");
      return [{ type: "text", content: "done" }];
    });
    open(a);
    const { taskId, result } = await runTask("w", "read-only");
    expect(result.finalState).toBe("needs_reconciliation");
    expect(result.reason).toContain("sneaky.txt");
    expect(repo.getTaskState(taskId)).toBe("needs_reconciliation");
    expect(a.executed).toBe(1);
    // Nothing re-runs it on its own.
    await new Promise((r) => setTimeout(r, 50));
    expect(a.executed).toBe(1);
    expect(repo.getTaskAttempt(taskId)).toBe(0);
  });

  it("the modified file of a read-only task is caught too (not only new files)", async () => {
    const a = new Scripted("w", (t) => {
      writeFileSync(join(t.cwd, "a.txt"), "changed\n");
      return [];
    });
    open(a);
    const { result } = await runTask("w", "read-only");
    expect(result.finalState).toBe("needs_reconciliation");
    expect(result.reason).toContain("a.txt");
  });

  it("a workspace-write task may change files in its folder", async () => {
    const a = new Scripted("w", (t) => {
      writeFileSync(join(t.cwd, "feature.txt"), "x");
      return [];
    });
    open(a);
    const { result } = await runTask("w", "workspace-write");
    expect(result.finalState).toBe("completed");
  });

  it("changes that were already there before the run are not blamed on a read-only task", async () => {
    writeFileSync(join(root, "earlier.txt"), "left by the implementer");
    const a = new Scripted("r", () => [{ type: "text", content: "reviewed" }]);
    open(a);
    const { result } = await runTask("r", "read-only");
    expect(result.finalState).toBe("completed");
  });

  it("a denial the CLI reported is recorded but does not fail the task when nothing changed", async () => {
    const a = new Scripted("r", () => [
      { type: "permission_denied", toolName: "Write", callId: "c1", input: { file_path: "x.txt" } },
    ]);
    open(a);
    const { taskId, result } = await runTask("r", "workspace-write");
    expect(result.finalState).toBe("completed");
    const kinds = repo.listMessages(taskId).map((m) => (m.payload as { type?: string }).type);
    expect(kinds).toContain("permission_denied");
  });

  it("a write the CLI said was denied, yet the file changed: needs_reconciliation", async () => {
    const a = new Scripted("r", (t) => {
      writeFileSync(join(t.cwd, "x.txt"), "it happened anyway");
      return [
        {
          type: "permission_denied",
          toolName: "Write",
          callId: "c1",
          input: { file_path: "x.txt" },
        },
      ];
    });
    open(a);
    const { result } = await runTask("r", "workspace-write");
    expect(result.finalState).toBe("needs_reconciliation");
    expect(result.reason).toContain("reported this write as denied");
  });

  it("a failing check is itself needs_reconciliation (fail-closed), never a silent pass", async () => {
    const a = new Scripted("w", () => []);
    let calls = 0;
    const workspaces = {
      status: async () => {
        if (++calls > 1) throw new Error("git went away");
        return { files: [] };
      },
    };
    open(a, { workspaces: () => workspaces });
    const { result } = await runTask("w", "read-only");
    expect(result.finalState).toBe("needs_reconciliation");
    expect(result.reason).toContain("could not verify");
  });

  it("without a baseline (not a git folder) the run is not checked afterwards", async () => {
    const a = new Scripted("w", () => []);
    open(a, {
      workspaces: () => ({
        status: async () => {
          throw new Error("not a git repository");
        },
      }),
    });
    const { result } = await runTask("w", "read-only");
    expect(result.finalState).toBe("completed");
  });

  it("events after the terminal event are not forwarded and the adapter is closed", async () => {
    let closed = false;
    const late: AgentAdapter = {
      id: "late",
      detect: async () => true,
      capabilities: async () => [],
      cancel: async () => {},
      async *execute() {
        try {
          yield { type: "text", content: "before" };
          yield { type: "completed" };
          yield { type: "text", content: "late" };
        } finally {
          closed = true;
        }
      },
    };
    open(late);
    const { result } = await runTask("late", "read-only");
    expect(result.finalState).toBe("completed");
    expect(result.events.map((e) => e.type)).toEqual(["text", "completed"]);
    expect(closed).toBe(true);
  });

  it("an adapter's own error still passes through when nothing changed", async () => {
    const failing: AgentAdapter = {
      id: "f",
      detect: async () => true,
      capabilities: async () => [],
      cancel: async () => {},
      async *execute() {
        yield { type: "error", message: "boom" };
      },
    };
    open(failing);
    const { result } = await runTask("f", "read-only");
    expect(result.finalState).toBe("failed");
    expect(result.reason).toBe("boom");
  });
});

async function waitForPending() {
  for (let i = 0; i < 200; i++) {
    const [first] = repo.listApprovals("pending");
    if (first) return first;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no approval was created");
}
