import {
  AgentEvent,
  TaskPermissions,
  type AgentMessage,
  type TaskState,
} from "@agent-studio/contracts";
import type { AdapterRegistry } from "@agent-studio/agent-core";
import type { Logger } from "@agent-studio/shared-utils";
import { newId } from "@agent-studio/shared-utils";
import type { Repo } from "@agent-studio/storage";
import { classifyOutcome, type FinalState } from "./outcome.js";

export interface RunResult {
  taskId: string;
  finalState: FinalState;
  /** Why the task ended in `failed` or `needs_reconciliation`, when known. */
  reason?: string;
  events: AgentEvent[];
}

/**
 * Phase 0 skeleton: runs ONE task on ONE adapter and persists every event as a
 * message. No scheduler, router or DAG yet (Phase 2).
 */
export interface OrchestratorHooks {
  /** After a message is persisted. */
  onMessage?: (message: AgentMessage) => void;
  /** After a task state change is persisted. */
  onState?: (taskId: string, state: TaskState, reason?: string) => void;
}

export class Orchestrator {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly repo: Repo,
    private readonly log: Logger,
    private readonly hooks: OrchestratorHooks = {},
  ) {}

  /** A broken listener (UI side) must never fail or alter a task. */
  private notify(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.warn({ err: String(err) }, "orchestrator hook threw");
    }
  }

  async runTask(opts: {
    workflowId: string;
    agentId: string;
    prompt: string;
    cwd: string;
    signal?: AbortSignal;
    /** Called synchronously once the task row exists, before any adapter work. */
    onCreated?: (taskId: string) => void;
  }): Promise<RunResult> {
    const adapter = this.registry.get(opts.agentId);
    if (!adapter) throw new Error(`Unknown agent: ${opts.agentId}`);

    const taskId = this.repo.createTask(opts.workflowId, opts.agentId);
    opts.onCreated?.(taskId);
    this.repo.setTaskState(taskId, "running");
    this.notify(() => this.hooks.onState?.(taskId, "running"));
    return this.drive({
      taskId,
      workflowId: opts.workflowId,
      agentId: opts.agentId,
      prompt: opts.prompt,
      cwd: opts.cwd,
      correlationId: newId("corr"),
      signal: opts.signal ?? new AbortController().signal,
    });
  }

  /**
   * Creates a `queued` task for the scheduler. The prompt (and permissions) are persisted as the task's
   * `task.request` message, so the task survives a restart and can be executed later by `execute`.
   */
  enqueue(opts: {
    workflowId: string;
    agentId: string;
    prompt: string;
    priority?: number;
    permissions?: TaskPermissions;
    /** Task ids that must complete first. A cycle is rejected. */
    dependsOn?: readonly string[];
  }): string {
    if (!this.registry.get(opts.agentId)) throw new Error(`Unknown agent: ${opts.agentId}`);
    const correlationId = newId("corr");
    const { taskId, stored } = this.repo.tx((r) => {
      const id = r.createTask(opts.workflowId, opts.agentId, {
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      });
      for (const dep of opts.dependsOn ?? []) r.addDependency(id, dep);
      const message = r.appendMessageAuto({
        id: newId("msg"),
        schemaVersion: 1,
        workflowId: opts.workflowId,
        taskId: id,
        correlationId,
        fromAgent: "orchestrator",
        toAgent: opts.agentId,
        type: "task.request",
        payload: {
          prompt: opts.prompt,
          ...(opts.permissions ? { permissions: opts.permissions } : {}),
        },
        createdAt: new Date().toISOString(),
      });
      return { taskId: id, stored: message };
    });
    this.notify(() => this.hooks.onMessage?.(stored));
    return taskId;
  }

  /**
   * Runs a task that a scheduler already claimed (state `running`). A task that cannot even be
   * prepared (missing request, unknown agent) has not touched anything, so it is safely `failed`.
   */
  async execute(taskId: string, opts: { signal?: AbortSignal } = {}): Promise<RunResult> {
    const task = this.repo.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.state !== "running") throw new Error(`Task ${taskId} is ${task.state}, not running`);
    const request = this.repo.listMessages(taskId).find((m) => m.type === "task.request");
    const payload = request?.payload as { prompt?: unknown; permissions?: unknown } | undefined;
    const root = this.repo.getWorkflowRoot(task.workflowId);
    const parsedPermissions = TaskPermissions.safeParse(payload?.permissions);
    const problem = !request
      ? "task has no task.request message"
      : typeof payload?.prompt !== "string"
        ? "task.request has no prompt"
        : !task.agentId || !this.registry.get(task.agentId)
          ? `unknown agent: ${String(task.agentId)}`
          : !root
            ? "workflow has no project root"
            : undefined;
    if (problem !== undefined || !request || !task.agentId || !root) {
      const reason = problem ?? "task cannot be prepared";
      this.repo.setTaskState(taskId, "failed", { reason });
      this.notify(() => this.hooks.onState?.(taskId, "failed", reason));
      return { taskId, finalState: "failed", reason, events: [] };
    }
    return this.drive({
      taskId,
      workflowId: task.workflowId,
      agentId: task.agentId,
      prompt: payload?.prompt as string,
      cwd: root.rootPath,
      ...(parsedPermissions.success ? { permissions: parsedPermissions.data } : {}),
      correlationId: request.correlationId,
      signal: opts.signal ?? new AbortController().signal,
    });
  }

  /** Shared core: the task is already `running`; run the adapter, persist events, settle the state. */
  private async drive(ctx: {
    taskId: string;
    workflowId: string;
    agentId: string;
    prompt: string;
    cwd: string;
    permissions?: TaskPermissions;
    correlationId: string;
    signal: AbortSignal;
  }): Promise<RunResult> {
    const { taskId, correlationId, signal } = ctx;
    const adapter = this.registry.get(ctx.agentId);
    if (!adapter) throw new Error(`Unknown agent: ${ctx.agentId}`);
    const record = (type: AgentMessage["type"], payload: unknown) => {
      const base = {
        id: newId("msg"),
        schemaVersion: 1 as const,
        workflowId: ctx.workflowId,
        taskId,
        correlationId,
        fromAgent: ctx.agentId,
        toAgent: "orchestrator",
        type,
        payload,
        createdAt: new Date().toISOString(),
      };
      // Sequence comes from the DB so a requeued task continues its log instead of colliding.
      const stored = this.repo.appendMessageAuto(base);
      this.notify(() => this.hooks.onMessage?.(stored));
    };

    record("task.accepted", { prompt: ctx.prompt });
    const events: AgentEvent[] = [];
    let abnormalEnd: string | undefined;
    try {
      for await (const raw of adapter.execute({
        id: taskId,
        prompt: ctx.prompt,
        cwd: ctx.cwd,
        ...(ctx.permissions ? { permissions: ctx.permissions } : {}),
        signal,
      })) {
        const parsed = AgentEvent.safeParse(raw);
        if (!parsed.success) {
          abnormalEnd = "adapter produced an invalid event";
          break;
        }
        const ev = parsed.data;
        events.push(ev);
        if (ev.type === "completed") {
          record("task.completed", ev);
          break;
        } else if (ev.type === "error") {
          record("task.failed", ev);
          break;
        } else {
          record("task.progress", ev);
        }
      }
    } catch (err) {
      this.log.error({ taskId, err: String(err) }, "adapter threw");
      abnormalEnd = `adapter threw: ${String(err)}`;
    }
    const outcome = classifyOutcome({
      events,
      ...(abnormalEnd !== undefined ? { abnormalEnd } : {}),
    });
    if (abnormalEnd !== undefined || outcome.state === "needs_reconciliation") {
      record("task.failed", {
        type: "error",
        message: outcome.reason ?? abnormalEnd,
        needsReconciliation: outcome.state === "needs_reconciliation",
      });
    }
    const finalState = outcome.state;
    this.repo.setTaskState(taskId, finalState, outcome.reason ? { reason: outcome.reason } : {});
    this.notify(() => this.hooks.onState?.(taskId, finalState, outcome.reason));
    this.log.info({ taskId, finalState, reason: outcome.reason }, "task finished");
    return { taskId, finalState, ...(outcome.reason ? { reason: outcome.reason } : {}), events };
  }

  /**
   * A person (or later a verified check) decides what happened to a `needs_reconciliation` task.
   * Nothing calls this automatically; `requeue` is the ONLY path that re-runs work and it bumps `attempt`.
   */
  resolveReconciliation(
    taskId: string,
    decision: "completed" | "failed" | "cancelled" | "requeue",
    note: string,
  ): void {
    const state = this.repo.getTaskState(taskId);
    if (state !== "needs_reconciliation") {
      throw new Error(`Task ${taskId} is ${String(state)}, not needs_reconciliation`);
    }
    const reason = `reconciled by user: ${note}`;
    if (decision === "requeue") {
      this.repo.setTaskState(taskId, "queued", { reason, incrementAttempt: true });
    } else {
      this.repo.setTaskState(taskId, decision, { reason });
    }
  }
}
