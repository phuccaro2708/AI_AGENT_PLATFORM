import { isTerminalTaskState, type AgentMessage, type TaskState } from "@agent-studio/contracts";
import type { GitWorktrees } from "@agent-studio/git-worktrees";
import { newId } from "@agent-studio/shared-utils";
import type { Repo } from "@agent-studio/storage";
import { assignRole, buildRolePrompt, parseVerdict, type RoleDef, type Verdict } from "./roles.js";
import type { TaskRunner } from "./runner.js";

export interface WorkflowEngineDeps {
  runner: TaskRunner;
  repo: Repo;
  worktreesFor: (rootPath: string) => GitWorktrees;
  /** Poll period while waiting for queued tasks to get a slot. Default 50 ms. */
  pollMs?: number;
}

export interface RoleAssignment {
  role: RoleDef;
  agentId: string;
}

export interface StepInfo {
  taskId: string;
  agentId: string;
  state: TaskState;
  branch: string;
  /** False when the agent changed nothing (so there was nothing to checkpoint). */
  committed: boolean;
}

export type PeerReviewOutcome =
  | "approved"
  | "changes_requested"
  | "verdict_unknown"
  | "no_changes"
  | "implement_failed"
  | "review_failed";

export interface PeerReviewResult {
  outcome: PeerReviewOutcome;
  implement: StepInfo;
  review?: { taskId: string; agentId: string; state: TaskState; verdict: Verdict };
}

export interface ParallelResult {
  workers: StepInfo[];
  /** Pairs of worker branches that would conflict if both were merged. */
  conflicts: { a: string; b: string; files: string[] }[];
}

const MAX_SUMMARY = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Multi-agent patterns on top of TaskRunner. Every agent works in its own worktree; the engine
 * checkpoint-commits finished work onto the agent's branch so the next agent can start from it.
 * Nothing is merged into the project's own branch: that stays a human decision.
 */
export class WorkflowEngine {
  private readonly pollMs: number;

  constructor(private readonly d: WorkflowEngineDeps) {
    this.pollMs = d.pollMs ?? 50;
  }

  /** Implement → review handoff (`review.request` / `review.result`). */
  async runPeerReview(o: {
    workflowId: string;
    goal: string;
    implementer: RoleAssignment;
    reviewer: RoleAssignment;
  }): Promise<PeerReviewResult> {
    const { repo, runner } = this.d;
    assignRole(o.implementer.role, o.implementer.agentId);
    assignRole(o.reviewer.role, o.reviewer.agentId);
    const root = repo.getWorkflowRoot(o.workflowId);
    if (!root) throw new Error(`Unknown workflow: ${o.workflowId}`);
    const worktrees = this.d.worktreesFor(root.rootPath);
    repo.setWorkflowState(o.workflowId, "running");

    const implId = runner.submit({
      workflowId: o.workflowId,
      agentId: o.implementer.agentId,
      prompt: buildRolePrompt(o.implementer.role, `Goal:\n${o.goal}`),
      isolate: true,
    });
    const implement = await this.finishStep(implId, o.implementer.agentId, worktrees);
    if (implement.state !== "completed") {
      repo.setWorkflowState(o.workflowId, "failed");
      return { outcome: "implement_failed", implement };
    }
    if (!implement.committed) {
      repo.setWorkflowState(o.workflowId, "completed");
      return { outcome: "no_changes", implement };
    }

    const wt = repo.getWorktree(implId)!;
    const diffStat = await worktrees.diffStat(wt.baseSha, implement.branch);
    const correlationId = newId("corr");
    const reviewPrompt = buildRolePrompt(
      o.reviewer.role,
      [
        `Goal that was implemented:\n${o.goal}`,
        `Changed files (verified by git, ${wt.baseSha.slice(0, 8)}..${implement.branch}):\n${diffStat}`,
        `Implementer's own summary (agent-reported, not verified):\n${this.finalText(implId).slice(0, MAX_SUMMARY)}`,
        "Your working directory already contains the implementer's changes.",
      ].join("\n\n"),
    );
    return this.reviewStep({
      o,
      worktrees,
      implement,
      implId,
      reviewPrompt,
      correlationId,
    });
  }

  private async reviewStep(a: {
    o: { workflowId: string; implementer: RoleAssignment; reviewer: RoleAssignment };
    worktrees: GitWorktrees;
    implement: StepInfo;
    implId: string;
    reviewPrompt: string;
    correlationId: string;
  }): Promise<PeerReviewResult> {
    const { repo, runner } = this.d;
    const { o, implement } = a;
    const rid = runner.submit({
      workflowId: o.workflowId,
      agentId: o.reviewer.agentId,
      prompt: a.reviewPrompt,
      isolate: true,
      baseRef: implement.branch,
    });
    this.record(
      a.implId,
      o.workflowId,
      "review.request",
      a.correlationId,
      o.implementer.agentId,
      o.reviewer.agentId,
      {
        reviewTaskId: rid,
        branch: implement.branch,
      },
    );
    const review = await this.finishStep(rid, o.reviewer.agentId, a.worktrees, false);
    if (review.state !== "completed") {
      repo.setWorkflowState(o.workflowId, "failed");
      return {
        outcome: "review_failed",
        implement,
        review: {
          taskId: rid,
          agentId: o.reviewer.agentId,
          state: review.state,
          verdict: "unknown",
        },
      };
    }
    const verdict = parseVerdict(this.finalText(rid));
    this.record(
      rid,
      o.workflowId,
      "review.result",
      a.correlationId,
      o.reviewer.agentId,
      o.implementer.agentId,
      {
        verdict,
        source: "agent-reported",
      },
    );
    repo.setWorkflowState(o.workflowId, verdict === "unknown" ? "paused" : "completed");
    const outcome: PeerReviewOutcome =
      verdict === "approve"
        ? "approved"
        : verdict === "changes_requested"
          ? "changes_requested"
          : "verdict_unknown";
    return {
      outcome,
      implement,
      review: { taskId: rid, agentId: o.reviewer.agentId, state: review.state, verdict },
    };
  }

  /** Several agents in parallel, each in its own worktree; reports which branches would conflict. */
  async runParallelWorkers(o: {
    workflowId: string;
    role: RoleDef;
    workers: { agentId: string; prompt: string }[];
  }): Promise<ParallelResult> {
    const { repo, runner } = this.d;
    for (const w of o.workers) assignRole(o.role, w.agentId);
    const root = repo.getWorkflowRoot(o.workflowId);
    if (!root) throw new Error(`Unknown workflow: ${o.workflowId}`);
    const worktrees = this.d.worktreesFor(root.rootPath);
    repo.setWorkflowState(o.workflowId, "running");

    const ids = o.workers.map((w) =>
      runner.submit({
        workflowId: o.workflowId,
        agentId: w.agentId,
        prompt: buildRolePrompt(o.role, w.prompt),
        isolate: true,
      }),
    );
    const workers = await Promise.all(
      ids.map((id, i) => this.finishStep(id, o.workers[i]!.agentId, worktrees)),
    );
    const conflicts: ParallelResult["conflicts"] = [];
    const done = workers.filter((w) => w.state === "completed" && w.committed);
    for (let i = 0; i < done.length; i++) {
      for (let j = i + 1; j < done.length; j++) {
        const { conflicts: files } = await worktrees.detectConflicts(
          done[i]!.branch,
          done[j]!.branch,
        );
        if (files.length) conflicts.push({ a: done[i]!.taskId, b: done[j]!.taskId, files });
      }
    }
    repo.setWorkflowState(
      o.workflowId,
      workers.every((w) => w.state === "completed") ? "completed" : "failed",
    );
    return { workers, conflicts };
  }

  /** Waits for a task to stop, then (for completed work) checkpoints its worktree onto its branch. */
  private async finishStep(
    taskId: string,
    agentId: string,
    worktrees: GitWorktrees,
    checkpoint = true,
  ): Promise<StepInfo> {
    const state = await this.waitStopped(taskId);
    const wt = this.d.repo.getWorktree(taskId);
    let committed = false;
    if (checkpoint && state === "completed" && wt) {
      committed = (await worktrees.commitAll(wt.path, `agent-studio: checkpoint ${taskId}`))
        .committed;
    }
    return { taskId, agentId, state, branch: wt?.branch ?? "", committed };
  }

  private async waitStopped(taskId: string): Promise<TaskState> {
    for (;;) {
      const st = this.d.repo.getTaskState(taskId);
      if (!st) throw new Error(`Unknown task: ${taskId}`);
      if (isTerminalTaskState(st) || st === "needs_reconciliation") return st;
      await this.d.runner.pump();
      await (this.d.runner.whenDone(taskId) ?? sleep(this.pollMs));
    }
  }

  /** Concatenated `text` events of a task: what the agent said, not something git verified. */
  private finalText(taskId: string): string {
    return this.d.repo
      .listMessages(taskId)
      .filter((m) => m.type === "task.progress")
      .map((m) => m.payload as { type?: string; content?: unknown })
      .filter((p) => p.type === "text" && typeof p.content === "string")
      .map((p) => p.content as string)
      .join("\n");
  }

  private record(
    taskId: string,
    workflowId: string,
    type: AgentMessage["type"],
    correlationId: string,
    from: string,
    to: string,
    payload: unknown,
  ): void {
    // Plain append: an audit trail of the handoff. Nothing consumes outbox deliveries yet.
    this.d.repo.appendMessage(
      {
        id: newId("msg"),
        schemaVersion: 1,
        workflowId,
        taskId,
        correlationId,
        fromAgent: from,
        toAgent: to,
        type,
        payload,
        createdAt: new Date().toISOString(),
      },
      this.d.repo.nextMessageSequence(taskId),
    );
  }
}
