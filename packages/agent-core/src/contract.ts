import { AgentCapability, AgentEvent } from "@agent-studio/contracts";

/** Events after which an adapter must stop. Exactly one of them ends every stream. */
export const isTerminalEvent = (e: AgentEvent): boolean =>
  e.type === "completed" || e.type === "error";

/**
 * Checks one finished event stream against the adapter contract. Returns violations
 * (empty = conforming). Pure, so both the shared contract tests and the orchestrator can use it.
 */
export function validateEventStream(events: readonly unknown[]): string[] {
  const problems: string[] = [];
  let terminalAt = -1;
  events.forEach((raw, i) => {
    const parsed = AgentEvent.safeParse(raw);
    if (!parsed.success) {
      problems.push(`event #${i} is not a valid AgentEvent`);
      return;
    }
    if (terminalAt !== -1) {
      problems.push(
        `event #${i} (${parsed.data.type}) came after the terminal event #${terminalAt}`,
      );
      return;
    }
    if (isTerminalEvent(parsed.data)) terminalAt = i;
  });
  if (terminalAt === -1)
    problems.push("stream ended without a terminal event (completed or error)");
  return problems;
}

/** Validates the value returned by `capabilities()`. */
export function validateCapabilities(caps: unknown): string[] {
  if (!Array.isArray(caps)) return ["capabilities() must return an array"];
  const problems: string[] = [];
  const seen = new Set<unknown>();
  for (const c of caps) {
    if (!AgentCapability.safeParse(c).success) problems.push(`unknown capability: ${String(c)}`);
    if (seen.has(c)) problems.push(`duplicate capability: ${String(c)}`);
    seen.add(c);
  }
  return problems;
}
