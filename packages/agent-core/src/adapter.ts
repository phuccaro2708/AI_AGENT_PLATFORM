import type { AgentCapability, AgentEvent, AgentTaskInput } from "@agent-studio/contracts";

/** Runtime task: serializable input plus a cancellation signal. */
export interface AgentTask extends AgentTaskInput {
  signal: AbortSignal;
}

/**
 * Contract every agent integration implements. Adapters must not claim
 * capabilities that were not verified by detection/probe.
 */
export interface AgentAdapter {
  readonly id: string;
  detect(): Promise<boolean>;
  capabilities(): Promise<AgentCapability[]>;
  execute(task: AgentTask): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
}
