import { z } from "zod";
import type { TaskState } from "@agent-studio/contracts";
import type { AdapterRegistry } from "@agent-studio/agent-core";
import type { GitWorktrees } from "@agent-studio/git-worktrees";
import type { Logger } from "@agent-studio/shared-utils";
import { newId } from "@agent-studio/shared-utils";
import type { Repo } from "@agent-studio/storage";
import type { Orchestrator } from "./orchestrator.js";
import type { Scheduler, SchedulerTick } from "./scheduler.js";

/** What must survive a restart for a queued task to still be runnable. Stored as `task.request` #0. */
const TaskSpec = z.object({
  prompt: z.string(),
  agentId: z.string(),
  isolate: z.boolean(),
  baseRef: z.string().optional(),
});
type TaskSpec = z.infer<typeof TaskSpec>;

export interface TaskRunnerDeps {
  orchestrator: Orchestrator;
  repo: Repo;
  scheduler: Scheduler;
  registry: AdapterRegistry;
  log: Logger;
  /** Factory per project root; only used for tasks submitted with `isolate`. */
  worktreesFor: (rootPath: string) => GitWorktrees;
  /** Lease renewal period; must be well under the Scheduler's `leaseMs`. Default 15 s. */
  heartbeatMs?: number;
}

/**
 * Glue between the DAG/Scheduler, per-task worktrees and the Orchestrator.
 * `submit` only queues; `pump` (call it on a timer or after events) starts what is ready.
 */
export class TaskRunner {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly heartbeatMs: number;

  constructor(private readonly d: TaskRunnerDeps) {
    this.heartbeatMs = d.heartbeatMs ?? 15_000;
  }

  submit(o: {
    workflowId: string;
    agentId: string;
    prompt: string;
    isolate?: boolean;
    baseRef?: string;
    priority?: number;
    dependsOn?: string[];
  }): string {
    if (!this.d.registry.get(o.agentId)) throw new Error(`Unknown agent: ${o.agentId}`);
    const spec: TaskSpec = {
      prompt: o.prompt,
      agentId: o.agentId,
      isolate: o.isolate ?? false,
      ...(o.baseRef !== undefined ? { baseRef: o.baseRef } : {}),
    };
    const id = this.d.repo.createTask(
      o.workflowId,
      o.agentId,
      o.priority !== undefined ? { priority: o.priority } : {},
    );
    for (const dep of o.dependsOn ?? []) this.d.repo.addDependency(id, dep);
    // Plain append (not the outbox): nothing consumes a task.request delivery yet.
    this.d.repo.appendMessage(
      {
        id: newId("msg"),
        schemaVersion: 1,
        workflowId: o.workflowId,
        taskId: id,
        correlationId: newId("corr"),
        fromAgent: "orchestrator",
        toAgent: o.agentId,
        type: "task.request",
        payload: spec,
        createdAt: new Date().toISOString(),
      },
      0,
    );
    return id;
  }

  /** Starts every ready task up to the concurrency limit; does not wait for them to finish. */
  async pump(): Promise<SchedulerTick> {
    const tick = this.d.scheduler.tick();
    for (const taskId of tick.started) {
      const abort = new AbortController();
      const done = this.run(taskId, abort.signal).catch((err) => {
        this.d.log.error({ taskId, err: String(err) }, "task runner crashed");
      });
      this.active.set(taskId, { abort, done });
      void done.finally(() => this.active.delete(taskId));
    }
    return tick;
  }

  /** Queued → cancelled immediately; running (in this process) → aborted, settles asynchronously. */
  cancel(taskId: string): TaskState | undefined {
    const running = this.active.get(taskId);
    if (running) {
      running.abort.abort();
      return this.d.repo.getTaskState(taskId);
    }
    if (this.d.repo.getTaskState(taskId) === "queued") {
      this.d.repo.setTaskState(taskId, "cancelled", { reason: "cancelled before start" });
    }
    return this.d.repo.getTaskState(taskId);
  }

  /** Resolves once every task started by this runner has finished (including cleanup). */
  async settle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((a) => a.done));
  }

  private readSpec(taskId: string): { spec: TaskSpec; workflowId: string } {
    const first = this.d.repo.listMessages(taskId)[0];
    if (!first || first.type !== "task.request")
      throw new Error(`task ${taskId} has no task.request`);
    return { spec: TaskSpec.parse(first.payload), workflowId: first.workflowId };
  }

  private async run(taskId: string, signal: AbortSignal): Promise<void> {
    const { orchestrator, repo, scheduler, log } = this.d;
    const { spec, workflowId } = this.readSpec(taskId);
    const root = repo.getWorkflowRoot(workflowId);
    if (!root) {
      orchestrator.failBeforeStart(
        taskId,
        workflowId,
        spec.agentId,
        "workflow has no project root",
      );
      return;
    }
    const beat = setInterval(() => scheduler.heartbeat(taskId), this.heartbeatMs);
    beat.unref();
    const worktrees = spec.isolate ? this.d.worktreesFor(root.rootPath) : undefined;
    try {
      let cwd = root.rootPath;
      if (worktrees) {
        try {
          const w = await worktrees.create({
            taskId,
            ...(spec.baseRef !== undefined ? { baseRef: spec.baseRef } : {}),
          });
          repo.registerWorktree({
            taskId,
            path: w.path,
            branch: w.branch,
            baseSha: w.baseSha,
          });
          cwd = w.path;
        } catch (err) {
          orchestrator.failBeforeStart(
            taskId,
            workflowId,
            spec.agentId,
            `could not create an isolated worktree: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
      let finalState: TaskState | undefined;
      try {
        finalState = (
          await orchestrator.executeScheduled(taskId, {
            workflowId,
            agentId: spec.agentId,
            prompt: spec.prompt,
            cwd,
            signal,
          })
        ).finalState;
      } catch (err) {
        // executeScheduled threw before it could settle the task; do not leave it `running`.
        log.error({ taskId, err: String(err) }, "execute failed");
        if (repo.getTaskState(taskId) === "running") {
          orchestrator.failBeforeStart(
            taskId,
            workflowId,
            spec.agentId,
            `execution error: ${String(err)}`,
          );
        }
      }
      if (worktrees && finalState === "cancelled") await this.cleanupCancelled(taskId, worktrees);
    } finally {
      clearInterval(beat);
    }
  }

  /** A cancelled task's worktree is removed only if it holds no uncommitted work (never force). */
  private async cleanupCancelled(taskId: string, worktrees: GitWorktrees): Promise<void> {
    try {
      await worktrees.remove({ taskId });
      this.d.repo.markWorktreeRemoved(taskId);
    } catch (err) {
      this.d.log.warn(
        { taskId, err: String(err) },
        "kept worktree of cancelled task (uncommitted changes or git error)",
      );
    }
  }
}
