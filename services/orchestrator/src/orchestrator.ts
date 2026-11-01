import type { AgentEvent, AgentMessage } from "@agent-studio/contracts";
import type { AdapterRegistry } from "@agent-studio/agent-core";
import type { Logger } from "@agent-studio/shared-utils";
import { newId } from "@agent-studio/shared-utils";
import type { Repo } from "@agent-studio/storage";

export interface RunResult {
  taskId: string;
  finalState: "completed" | "failed" | "cancelled";
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
    let finalState: RunResult["finalState"] = "failed";
    try {
      for await (const ev of adapter.execute({
        id: taskId,
        prompt: opts.prompt,
        cwd: opts.cwd,
        signal,
      })) {
        events.push(ev);
        if (ev.type === "completed") {
          finalState = "completed";
          record("task.completed", ev);
        } else if (ev.type === "error") {
          finalState = ev.message === "cancelled" ? "cancelled" : "failed";
          record("task.failed", ev);
        } else {
          record("task.progress", ev);
        }
      }
    } catch (err) {
      this.log.error({ taskId, err: String(err) }, "adapter threw");
      record("task.failed", { type: "error", message: String(err) });
    }
    this.repo.setTaskState(taskId, finalState);
    this.log.info({ taskId, finalState }, "task finished");
    return { taskId, finalState, events };
  }
}
