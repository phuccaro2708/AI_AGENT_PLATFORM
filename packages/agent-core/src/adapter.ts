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
  /**
   * The exact program and argument list `execute` would start for this task, without starting anything.
   * The orchestrator asks the Policy Engine about it BEFORE `execute` (Phase 4, P4-1a). Adapters that do not
   * spawn a program (fakes, in-process agents) leave it out and are only checked on the working directory.
   */
  describeLaunch?(task: AgentTask): { command: string; args: readonly string[] };
}
