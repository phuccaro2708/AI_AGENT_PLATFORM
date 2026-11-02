import type { AgentEvent } from "@agent-studio/contracts";

export type FinalState = "completed" | "failed" | "cancelled" | "needs_reconciliation";

export interface Outcome {
  state: FinalState;
  /** Set when the state is `needs_reconciliation` (or a failure worth explaining). */
  reason?: string;
}

/**
 * Decides the final task state from what the adapter reported.
 *
 * Rule (CLAUDE.md #6): if work may have changed things and we cannot verify it, the task is
 * `needs_reconciliation` and is never retried automatically.
 *
 * "May have changed things" is judged from the events only: a `tool_call` without a matching
 * `tool_result`. `tool_result` carries no call id, so calls and results are counted. We cannot tell a
 * read-only tool from a writing one, so any unfinished tool is treated as unverified. This relies on
 * the adapter reporting `tool_call` faithfully; an adapter that hides tool use defeats it.
 */
export function classifyOutcome(input: {
  events: readonly AgentEvent[];
  /** The adapter threw, or produced an invalid event / no terminal event. */
  abnormalEnd?: string;
}): Outcome {
  const { events, abnormalEnd } = input;
  let calls = 0;
  let results = 0;
  let terminal: Extract<AgentEvent, { type: "completed" | "error" }> | undefined;
  for (const e of events) {
    if (e.type === "tool_call") calls++;
    else if (e.type === "tool_result") results++;
    if (e.type === "completed" || e.type === "error") {
      terminal = e;
      break;
    }
  }
  const unfinishedTools = calls > results;
  const unverified = (why: string): Outcome => ({
    state: "needs_reconciliation",
    reason: `${why}; ${calls - results} tool call(s) had no result, so side effects are unverified`,
  });

  if (abnormalEnd !== undefined || terminal === undefined) {
    const why = abnormalEnd ?? "adapter stream ended without a terminal event";
    return unfinishedTools ? unverified(why) : { state: "failed", reason: why };
  }
  if (terminal.type === "completed") return { state: "completed" };
  // terminal.type === "error"
  if (terminal.message === "cancelled") {
    return unfinishedTools
      ? unverified("cancelled while a tool was running")
      : { state: "cancelled" };
  }
  return unfinishedTools
    ? unverified(`adapter reported an error (${terminal.message})`)
    : { state: "failed", reason: terminal.message };
}
