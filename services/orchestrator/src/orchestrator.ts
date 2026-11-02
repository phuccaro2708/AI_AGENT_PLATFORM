import { AgentEvent, type AgentMessage } from "@agent-studio/contracts";
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
export class Orchestrator {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly repo: Repo,
    private readonly log: Logger,
  ) {}

  async runTask(opts: {
    workflowId: string;
    agentId: string;
    prompt: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    const adapter = this.registry.get(opts.agentId);
    if (!adapter) throw new Error(`Unknown agent: ${opts.agentId}`);

    const taskId = this.repo.createTask(opts.workflowId, opts.agentId);
    const correlationId = newId("corr");
    const signal = opts.signal ?? new AbortController().signal;
    let sequence = 0;
    const record = (type: AgentMessage["type"], payload: unknown) =>
      this.repo.appendMessage(
        {
          id: newId("msg"),
          schemaVersion: 1,
          workflowId: opts.workflowId,
          taskId,
          correlationId,
          fromAgent: opts.agentId,
          toAgent: "orchestrator",
          type,
          payload,
          createdAt: new Date().toISOString(),
        },
        sequence++,
      );

    this.repo.setTaskState(taskId, "running");
    record("task.accepted", { prompt: opts.prompt });
    const events: AgentEvent[] = [];
    let abnormalEnd: string | undefined;
    try {
      for await (const raw of adapter.execute({
        id: taskId,
        prompt: opts.prompt,
        cwd: opts.cwd,
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
