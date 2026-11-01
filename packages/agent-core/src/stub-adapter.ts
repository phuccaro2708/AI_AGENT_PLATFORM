import type { AgentCapability, AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "./adapter.js";

/** Deterministic adapter for tests: no process, no network, no randomness. */
export class StubAdapter implements AgentAdapter {
  readonly id: string;
  private readonly cancelled = new Set<string>();

  constructor(id = "stub") {
    this.id = id;
  }

  async detect(): Promise<boolean> {
    return true;
  }

  async capabilities(): Promise<AgentCapability[]> {
    return ["streaming", "structured_output"];
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
  }

  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    const stopped = () => task.signal.aborted || this.cancelled.has(task.id);
    const steps: AgentEvent[] = [
      { type: "text", content: `stub: received "${task.prompt}"` },
      { type: "tool_call", name: "stub.echo", args: { cwd: task.cwd } },
      { type: "tool_result", result: { ok: true } },
      { type: "text", content: "stub: done" },
    ];
    for (const step of steps) {
      if (stopped()) {
        yield { type: "error", message: "cancelled" };
        return;
      }
      yield step;
      await Promise.resolve(); // yield to the event loop so cancellation can interleave
    }
    yield { type: "completed", sessionId: `stub-session-${task.id}` };
  }
}
