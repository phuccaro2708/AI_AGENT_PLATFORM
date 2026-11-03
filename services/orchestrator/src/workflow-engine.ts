import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTerminalTaskState, type AgentMessage, type TaskState } from "@agent-studio/contracts";
import type { GitWorktrees } from "@agent-studio/git-worktrees";
import { newId } from "@agent-studio/shared-utils";
import type { Repo } from "@agent-studio/storage";
import { assignRole, buildRolePrompt, parseVerdict, type RoleDef, type Verdict } from "./roles.js";
import { ContextBoard } from "./context-board.js";
import { parsePlan, planInstructions, type Subtask } from "./plan.js";
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

export type SupervisedOutcome =
  "completed" | "supervisor_failed" | "plan_invalid" | "subtask_failed";

export interface SupervisedResult {
  outcome: SupervisedOutcome;
  supervisor: StepInfo;
  /** Why the plan was rejected (outcome `plan_invalid`). */
  error?: string;
  steps: (StepInfo & { subtaskId: string })[];
  /** Subtasks never started because something they depend on failed. */
  skipped: string[];
  conflicts: ParallelResult["conflicts"];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Multi-agent patterns on top of TaskRunner. Every agent works in its own worktree; the engine
 * checkpoint-commits finished work onto the agent's branch so the next agent can start from it.
 * Nothing is merged into the project's own branch: that stays a human decision.
 */
export class WorkflowEngine {
  private readonly pollMs: number;
  /** What agents are told about each other's work. Roles see only the kinds in their `sees`. */
  readonly board: ContextBoard;

  constructor(private readonly d: WorkflowEngineDeps) {
    this.pollMs = d.pollMs ?? 50;
    this.board = new ContextBoard(d.repo);
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

    this.board.add(o.workflowId, { kind: "goal", source: "user", content: o.goal });
    const implId = runner.submit({
      workflowId: o.workflowId,
      agentId: o.implementer.agentId,
      prompt: buildRolePrompt(
        o.implementer.role,
        this.board.render(o.workflowId, o.implementer.role),
      ),
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

    await this.recordWork(o.workflowId, implId, implement, worktrees);
    const correlationId = newId("corr");
    const reviewPrompt = buildRolePrompt(
      o.reviewer.role,
      [
        this.board.render(o.workflowId, o.reviewer.role),
        "Your working directory already contains the implementer's changes.",
      ]
        .filter(Boolean)
        .join("\n\n"),
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
    /** Recorded on the board (source `user`) and shown to workers whose role sees goals. */
    goal?: string;
  }): Promise<ParallelResult> {
    const { repo, runner } = this.d;
    for (const w of o.workers) assignRole(o.role, w.agentId);
    const root = repo.getWorkflowRoot(o.workflowId);
    if (!root) throw new Error(`Unknown workflow: ${o.workflowId}`);
    const worktrees = this.d.worktreesFor(root.rootPath);
    repo.setWorkflowState(o.workflowId, "running");

    if (o.goal) this.board.add(o.workflowId, { kind: "goal", source: "user", content: o.goal });
    const boardText = this.board.render(o.workflowId, o.role);
    const ids = o.workers.map((w) =>
      runner.submit({
        workflowId: o.workflowId,
        agentId: w.agentId,
        prompt: buildRolePrompt(o.role, [boardText, w.prompt].filter(Boolean).join("\n\n")),
        isolate: true,
      }),
    );
    const workers = await Promise.all(
      ids.map(async (id, i) => {
        const step = await this.finishStep(id, o.workers[i]!.agentId, worktrees);
        if (step.committed) await this.recordWork(o.workflowId, id, step, worktrees);
        return step;
      }),
    );
    const conflicts = await this.conflictsAmong(workers, worktrees);
    repo.setWorkflowState(
      o.workflowId,
      workers.every((w) => w.state === "completed") ? "completed" : "failed",
    );
    return { workers, conflicts };
  }

  /**
   * Supervisor pattern: one agent turns the goal into a plan (validated JSON), then the subtasks run
   * layer by layer in their own worktrees. A subtask with exactly one dependency starts from that
   * dependency's branch; with several it starts from the project's HEAD and learns about the others
   * only through the board (merging branches is a human decision). An invalid plan pauses the
   * workflow; nothing is retried or repaired.
   */
  async runSupervised(o: {
    workflowId: string;
    goal: string;
    supervisor: RoleAssignment;
    workerRole: RoleDef;
    /** Agents allowed to take subtasks; the first is the default for subtasks that name none. */
    workerAgents: string[];
    maxSubtasks?: number;
  }): Promise<SupervisedResult> {
    const { repo, runner } = this.d;
    const max = o.maxSubtasks ?? 8;
    if (o.workerAgents.length === 0)
      throw new Error("runSupervised needs at least one worker agent");
    assignRole(o.supervisor.role, o.supervisor.agentId);
    for (const a of o.workerAgents) assignRole(o.workerRole, a);
    const root = repo.getWorkflowRoot(o.workflowId);
    if (!root) throw new Error(`Unknown workflow: ${o.workflowId}`);
    const worktrees = this.d.worktreesFor(root.rootPath);
    repo.setWorkflowState(o.workflowId, "running");
    this.board.add(o.workflowId, { kind: "goal", source: "user", content: o.goal });

    const supId = runner.submit({
      workflowId: o.workflowId,
      agentId: o.supervisor.agentId,
      prompt: buildRolePrompt(
        o.supervisor.role,
        [
          this.board.render(o.workflowId, o.supervisor.role),
          planInstructions({ maxSubtasks: max, agents: o.workerAgents }),
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
      isolate: true,
    });
    const supervisor = await this.finishStep(supId, o.supervisor.agentId, worktrees, false);
    const base = { supervisor, steps: [], skipped: [], conflicts: [] };
    if (supervisor.state !== "completed") {
      repo.setWorkflowState(o.workflowId, "failed");
      return { outcome: "supervisor_failed", ...base };
    }
    const plan = parsePlan(this.lastText(supId), { maxSubtasks: max, agents: o.workerAgents });
    if (!plan.ok) {
      repo.setWorkflowState(o.workflowId, "paused");
      return { outcome: "plan_invalid", error: plan.error, ...base };
    }
    this.board.add(o.workflowId, {
      kind: "plan",
      source: "agent-reported",
      authorTaskId: supId,
      content: plan.subtasks
        .map(
          (t, i) =>
            `${i + 1}. [${t.id}] ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`,
        )
        .join("\n"),
    });

    const steps: SupervisedResult["steps"] = [];
    const byId = new Map<string, SupervisedResult["steps"][number]>();
    const skipped: string[] = [];
    for (const layer of plan.layers) {
      const runnable: Subtask[] = [];
      for (const t of layer) {
        const deps = t.dependsOn.map((d) => byId.get(d));
        if (deps.every((d) => d?.state === "completed")) runnable.push(t);
        else skipped.push(t.id);
      }
      const boardText = this.board.render(o.workflowId, o.workerRole);
      const ids = runnable.map((t) => {
        const deps = t.dependsOn.map((d) => byId.get(d)!);
        const from = deps.length === 1 && deps[0]!.committed ? deps[0]!.branch : undefined;
        return runner.submit({
          workflowId: o.workflowId,
          agentId: t.agent ?? o.workerAgents[0]!,
          prompt: buildRolePrompt(
            o.workerRole,
            [boardText, `Your subtask [${t.id}] ${t.title}:\n${t.prompt}`]
              .filter(Boolean)
              .join("\n\n"),
          ),
          isolate: true,
          dependsOn: deps.map((d) => d.taskId),
          ...(from ? { baseRef: from } : {}),
        });
      });
      const done = await Promise.all(
        ids.map(async (id, i) => {
          const t = runnable[i]!;
          const step = await this.finishStep(id, t.agent ?? o.workerAgents[0]!, worktrees);
          if (step.committed) await this.recordWork(o.workflowId, id, step, worktrees);
          return { ...step, subtaskId: t.id };
        }),
      );
      for (const d of done) {
        steps.push(d);
        byId.set(d.subtaskId, d);
      }
    }
    const conflicts = await this.conflictsAmong(steps, worktrees);
    const ok = skipped.length === 0 && steps.every((x) => x.state === "completed");
    repo.setWorkflowState(o.workflowId, ok ? "completed" : "failed");
    return { outcome: ok ? "completed" : "subtask_failed", supervisor, steps, skipped, conflicts };
  }

  /** Pairs of finished, committed branches that would conflict if both were merged. */
  private async conflictsAmong(
    steps: StepInfo[],
    worktrees: GitWorktrees,
  ): Promise<ParallelResult["conflicts"]> {
    const conflicts: ParallelResult["conflicts"] = [];
    const done = steps.filter((w) => w.state === "completed" && w.committed);
    for (let i = 0; i < done.length; i++) {
      for (let j = i + 1; j < done.length; j++) {
        const { conflicts: files } = await worktrees.detectConflicts(
          done[i]!.branch,
          done[j]!.branch,
        );
        if (files.length) conflicts.push({ a: done[i]!.taskId, b: done[j]!.taskId, files });
      }
    }
    return conflicts;
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

  /**
   * Puts a finished step on the board: the files git says changed (hashed by us from the worktree,
   * so `verified`) and the agent's last text message as its report (`agent-reported`). Nothing
   * else the agent produced (tool calls, intermediate text) is copied.
   */
  private async recordWork(
    workflowId: string,
    taskId: string,
    step: StepInfo,
    worktrees: GitWorktrees,
  ): Promise<void> {
    const wt = this.d.repo.getWorktree(taskId);
    if (!wt) return;
    for (const f of await worktrees.changedFiles(wt.baseSha, step.branch)) {
      const entry = {
        kind: "artifact" as const,
        source: "verified" as const,
        authorTaskId: taskId,
      };
      if (f.deleted) {
        this.board.add(workflowId, { ...entry, content: "", path: f.path, sha256: null });
        continue;
      }
      const full = join(wt.path, f.path);
      if (lstatSync(full).isFile()) {
        const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
        this.board.add(workflowId, { ...entry, content: "", path: f.path, sha256 });
      } else {
        this.board.add(workflowId, {
          ...entry,
          content: "not a regular file, not hashed",
          path: f.path,
          sha256: null,
        });
      }
    }
    const report = this.lastText(taskId);
    if (report) {
      this.board.add(workflowId, {
        kind: "report",
        source: "agent-reported",
        content: report,
        authorTaskId: taskId,
      });
    }
  }

  /** The agent's final `text` event: its own account of the work, not something git verified. */
  private lastText(taskId: string): string {
    return this.texts(taskId).at(-1) ?? "";
  }

  private texts(taskId: string): string[] {
    return this.d.repo
      .listMessages(taskId)
      .filter((m) => m.type === "task.progress")
      .map((m) => m.payload as { type?: string; content?: unknown })
      .filter((p) => p.type === "text" && typeof p.content === "string")
      .map((p) => p.content as string);
  }

  /** Concatenated `text` events of a task (used to find the reviewer's VERDICT line). */
  private finalText(taskId: string): string {
    return this.texts(taskId).join("\n");
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
