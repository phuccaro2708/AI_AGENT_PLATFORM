import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentEvent,
  ReviewResultPayload,
  type AgentMessage,
  type TaskState,
} from "@agent-studio/contracts";
import { newId } from "@agent-studio/shared-utils";
import type { Repo } from "@agent-studio/storage";
import type { ContextBoard } from "./context-board.js";
import type { Orchestrator, RunResult } from "./orchestrator.js";
import type { FinalState } from "./outcome.js";

/** The slice of `GitWorktrees` the engine needs; kept structural so tests can use a plain directory. */
export interface Workspaces {
  create(
    workflowId: string,
    taskId: string,
  ): Promise<{ path: string; branch: string; baseRef: string }>;
  status(path: string): Promise<{ dirty: boolean; files: { path: string; code: string }[] }>;
}

const IMPLEMENTER = "implementer";
const REVIEWER = "reviewer";

const IMPLEMENTER_INSTRUCTIONS =
  "You are the implementer. Make the change the goal asks for inside your working directory, and nothing else.";
const REVIEWER_INSTRUCTIONS =
  "You are the reviewer. Inspect the working directory without modifying it. " +
  'Finish with ONE line of JSON: {"verdict":"approve"|"request_changes","comments":["..."]}.';

type Step = {
  kind: "implement" | "review";
  workflowId: string;
  round: number;
  /** Reviewer only: the worktree contents when the review began, to detect modification. */
  snapshot?: string;
};

/**
 * Peer Review: an implementer works in its own worktree, then a read-only reviewer inspects that worktree and
 * returns a verdict; `request_changes` loops back to the implementer for up to `maxRounds` rounds.
 *
 * Agents only communicate through the context board (filtered per role) and review.request/review.result
 * messages. A reviewer's read-only status is enforced by CLI flags where the CLI supports them, and is
 * CHECKED here after the run (detect, not prevent): a reviewer that changed the worktree fails the workflow.
 *
 * Step bookkeeping is in memory, but it can be rebuilt from the database (`resume`): tasks of a workflow
 * alternate implementer, reviewer, implementer, ... in creation order. A task that ended in
 * `needs_reconciliation` is never continued by the engine; the workflow waits until a person decides.
 * Not persisted: a custom `maxRounds` (a resumed workflow uses the default).
 */
export class PeerReviewEngine {
  private readonly repo: Repo;
  private readonly orchestrator: Orchestrator;
  private readonly board: ContextBoard;
  private readonly workspaces: Workspaces;
  private readonly maxRounds: number;
  private readonly steps = new Map<string, Step>();
  private readonly roundLimits = new Map<string, number>();

  constructor(opts: {
    repo: Repo;
    orchestrator: Orchestrator;
    board: ContextBoard;
    workspaces: Workspaces;
    /** Implement→review rounds before giving up. Default 2. */
    maxRounds?: number;
  }) {
    this.repo = opts.repo;
    this.orchestrator = opts.orchestrator;
    this.board = opts.board;
    this.workspaces = opts.workspaces;
    this.maxRounds = opts.maxRounds ?? 2;
  }

  /** Assigns agents to the two roles for this run; nothing is hard-coded to a vendor. */
  defineRoles(
    workflowId: string,
    agents: { implementerAgent: string; reviewerAgent: string },
  ): void {
    this.repo.upsertRole({
      workflowId,
      name: IMPLEMENTER,
      instructions: IMPLEMENTER_INSTRUCTIONS,
      permissions: "workspace-write",
      allowedAgents: [agents.implementerAgent],
      visibleKinds: ["goal", "plan", "decision"],
    });
    this.repo.upsertRole({
      workflowId,
      name: REVIEWER,
      instructions: REVIEWER_INSTRUCTIONS,
      permissions: "read-only",
      allowedAgents: [agents.reviewerAgent],
      visibleKinds: ["goal", "artifact"],
    });
  }

  start(opts: { workflowId: string; goal: string; maxRounds?: number }): void {
    // State first: a workflow that is not `pending` must be refused before anything is written.
    this.repo.setWorkflowState(opts.workflowId, "running");
    this.board.add({
      workflowId: opts.workflowId,
      kind: "goal",
      content: opts.goal,
      source: "verified",
      createdBy: "user",
    });
    if (opts.maxRounds !== undefined) this.roundLimits.set(opts.workflowId, opts.maxRounds);
    this.enqueueImplement(opts.workflowId, 1);
  }

  /** Wire into `OrchestratorHooks.resolveCwd`: the first implementer task gets a worktree. */
  async resolveCwd(ctx: { taskId: string; workflowId: string }): Promise<string | undefined> {
    if (this.steps.get(ctx.taskId)?.kind !== "implement") return undefined;
    // A requeued implementer continues in the worktree the earlier attempt left behind.
    const existing = this.worktreeOfWorkflow(ctx.workflowId);
    if (existing && existing.state === "active") return existing.path;
    const wt = await this.workspaces.create(ctx.workflowId, ctx.taskId);
    const id = this.repo.createWorktree({
      workflowId: ctx.workflowId,
      taskId: ctx.taskId,
      path: wt.path,
      branch: wt.branch,
      baseRef: wt.baseRef,
    });
    this.repo.setWorktreeState(id, "active");
    return wt.path;
  }

  /** Wire into `SchedulerOptions.onSettled`. */
  async onSettled(taskId: string, result: RunResult | undefined): Promise<void> {
    const step = this.steps.get(taskId);
    if (!step) return;
    this.steps.delete(taskId);
    // Side effects unknown: wait for a person (`resume` runs after the decision), never fail or retry here.
    if (result?.finalState === "needs_reconciliation") return;
    try {
      if (!result || result.finalState !== "completed") {
        this.fail(step.workflowId, `${step.kind} task ${result?.finalState ?? "did not finish"}`);
        return;
      }
      if (step.kind === "implement") await this.afterImplement(taskId, step, result);
      else await this.afterReview(taskId, step, result);
    } catch (err) {
      this.fail(step.workflowId, `workflow engine error: ${String(err)}`);
    }
  }

  /**
   * Re-attaches the engine to a `running` workflow after a restart or after a person settled a
   * `needs_reconciliation` task. Waiting tasks get their step back; if the newest task already
   * ended (and nothing follows it) the workflow continues from there. Safe to call repeatedly.
   */
  async resume(workflowId: string): Promise<void> {
    if (this.repo.getWorkflowState(workflowId) !== "running") return;
    const tasks = this.repo.listTasks(workflowId);
    if (tasks.length === 0) return;
    const steps = tasks.map((_t, i) => this.rebuildStep(workflowId, tasks, i));
    tasks.forEach((t, i) => {
      if (!this.steps.has(t.id) && !isSettled(t.state as TaskState))
        this.steps.set(t.id, steps[i]!);
    });
    const last = tasks.at(-1)!;
    const state = last.state as TaskState;
    if (this.steps.has(last.id) || !isSettled(state) || state === "needs_reconciliation") return;
    this.steps.set(last.id, steps.at(-1)!);
    await this.onSettled(last.id, this.resultOf(last.id, state as FinalState));
  }

  /** Resumes every `running` workflow; call once at startup. */
  async resumeAll(): Promise<void> {
    for (const id of this.repo.listWorkflowIdsByState("running")) await this.resume(id);
  }

  private rebuildStep(workflowId: string, tasks: { id: string }[], index: number): Step {
    const kind = index % 2 === 0 ? "implement" : "review";
    const step: Step = { kind, workflowId, round: Math.floor(index / 2) + 1 };
    if (kind === "review") {
      const request = this.repo
        .listMessages(tasks[index - 1]!.id)
        .find((m) => m.type === "review.request");
      const artifacts = (request?.payload as { artifacts?: unknown } | undefined)?.artifacts;
      if (Array.isArray(artifacts)) step.snapshot = JSON.stringify(artifacts);
    }
    return step;
  }

  private resultOf(taskId: string, finalState: FinalState): RunResult {
    const events = this.repo.listMessages(taskId).flatMap((m) => {
      const parsed = AgentEvent.safeParse(m.payload);
      return parsed.success && m.type.startsWith("task.") ? [parsed.data] : [];
    });
    return { taskId, finalState, events };
  }

  private roleInstructions(workflowId: string, roleName: string) {
    const role = this.repo.listRoles(workflowId).find((r) => r.name === roleName);
    if (!role) throw new Error(`Unknown role: ${roleName}`);
    return role;
  }

  private promptFor(workflowId: string, roleName: string, tail = ""): string {
    const role = this.roleInstructions(workflowId, roleName);
    return `${role.instructions}\n\n${this.board.renderFor(workflowId, roleName).text}${tail}`;
  }

  private enqueueImplement(workflowId: string, round: number, cwd?: string): void {
    const role = this.roleInstructions(workflowId, IMPLEMENTER);
    const agentId = role.allowedAgents[0];
    if (!agentId) throw new Error("implementer role has no agent");
    const taskId = this.orchestrator.enqueue({
      workflowId,
      agentId,
      prompt: this.promptFor(workflowId, IMPLEMENTER),
      permissions: role.permissions,
      ...(cwd ? { cwd } : {}),
    });
    this.steps.set(taskId, { kind: "implement", workflowId, round });
  }

  private async afterImplement(taskId: string, step: Step, result: RunResult): Promise<void> {
    const wt = this.repo.getWorktreeForTask(taskId) ?? this.worktreeOfWorkflow(step.workflowId);
    if (!wt) throw new Error("implementer finished but has no worktree");

    const files = await this.snapshotFiles(wt.path);
    for (const f of files) {
      this.repo.registerArtifact(taskId, f.path, f.sha256);
      this.board.add({
        workflowId: step.workflowId,
        kind: "artifact",
        content: "changed by the implementer",
        path: f.path,
        sha256: f.sha256,
        source: "verified",
        createdBy: "orchestrator",
      });
    }

    const summary = lastText(result) ?? "(no summary)";
    this.record(step.workflowId, taskId, "review.request", IMPLEMENTER, REVIEWER, {
      summary,
      artifacts: files,
    });

    const role = this.roleInstructions(step.workflowId, REVIEWER);
    const agentId = role.allowedAgents[0];
    if (!agentId) throw new Error("reviewer role has no agent");
    const reviewId = this.orchestrator.enqueue({
      workflowId: step.workflowId,
      agentId,
      prompt: this.promptFor(step.workflowId, REVIEWER),
      permissions: role.permissions,
      cwd: wt.path,
    });
    this.steps.set(reviewId, {
      kind: "review",
      workflowId: step.workflowId,
      round: step.round,
      snapshot: JSON.stringify(files),
    });
  }

  private async afterReview(taskId: string, step: Step, result: RunResult): Promise<void> {
    const wt = this.worktreeOfWorkflow(step.workflowId);
    if (!wt) throw new Error("reviewer finished but the workflow has no worktree");

    const after = JSON.stringify(await this.snapshotFiles(wt.path));
    if (after !== step.snapshot) {
      this.board.add({
        workflowId: step.workflowId,
        kind: "decision",
        content: "The read-only reviewer changed the worktree; its verdict was discarded.",
        source: "verified",
        createdBy: "orchestrator",
      });
      this.fail(step.workflowId, "the read-only reviewer modified the worktree");
      return;
    }

    const verdict = parseVerdict(result);
    if (!verdict) {
      this.fail(step.workflowId, "the reviewer gave no valid verdict");
      return;
    }
    this.record(step.workflowId, taskId, "review.result", REVIEWER, IMPLEMENTER, verdict);

    if (verdict.verdict === "approve") {
      this.repo.setWorkflowState(step.workflowId, "completed");
      return;
    }
    if (step.round >= (this.roundLimits.get(step.workflowId) ?? this.maxRounds)) {
      this.fail(step.workflowId, `changes still requested after ${step.round} round(s)`);
      return;
    }
    for (const comment of verdict.comments) {
      this.board.add({
        workflowId: step.workflowId,
        kind: "decision",
        content: `Reviewer: ${comment}`,
        source: "agent_reported",
        createdBy: REVIEWER,
      });
    }
    this.enqueueImplement(step.workflowId, step.round + 1, wt.path);
  }

  private worktreeOfWorkflow(workflowId: string) {
    return this.repo.listWorktrees(workflowId)[0];
  }

  /** Every changed file with its content hash; deleted files have nothing to hash and are skipped. */
  private async snapshotFiles(path: string): Promise<{ path: string; sha256: string }[]> {
    const status = await this.workspaces.status(path);
    const out: { path: string; sha256: string }[] = [];
    for (const f of status.files) {
      try {
        const sha256 = createHash("sha256")
          .update(readFileSync(join(path, f.path)))
          .digest("hex");
        out.push({ path: f.path, sha256 });
      } catch {
        // deleted or a directory: not an artifact
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private record(
    workflowId: string,
    taskId: string,
    type: AgentMessage["type"],
    from: string,
    to: string,
    payload: unknown,
  ): void {
    const last = this.repo.listMessages(taskId).at(-1);
    this.repo.appendMessageAuto({
      id: newId("msg"),
      schemaVersion: 1,
      workflowId,
      taskId,
      correlationId: last?.correlationId ?? newId("corr"),
      fromAgent: from,
      toAgent: to,
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  private fail(workflowId: string, reason: string): void {
    const state = this.repo.getWorkflowState(workflowId);
    if (state === "running" || state === "paused" || state === "pending") {
      this.repo.setWorkflowState(workflowId, "failed");
    }
    this.board.add({
      workflowId,
      kind: "decision",
      content: `Workflow failed: ${reason}`,
      source: "verified",
      createdBy: "orchestrator",
    });
  }
}

const isSettled = (s: TaskState) =>
  s === "completed" || s === "failed" || s === "cancelled" || s === "needs_reconciliation";

function texts(result: RunResult): string[] {
  return result.events.flatMap((e) => (e.type === "text" ? [e.content] : []));
}

function lastText(result: RunResult): string | undefined {
  return texts(result).at(-1);
}

/** The last text that parses as a review verdict; free-form chatter before it is ignored. */
function parseVerdict(result: RunResult) {
  for (const t of texts(result).reverse()) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    try {
      const parsed = ReviewResultPayload.safeParse(JSON.parse(t.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
    } catch {
      // not JSON
    }
  }
  return undefined;
}
