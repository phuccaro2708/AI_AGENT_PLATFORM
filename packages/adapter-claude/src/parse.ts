import type { AgentEvent } from "@agent-studio/contracts";

/** What one stdout line of `claude -p --output-format stream-json` means for us. */
export interface ParsedLine {
  events: AgentEvent[];
  /** Set by the `result` line: the run is over and this is how it ended. */
  final?: AgentEvent;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * Pure mapper. Unknown types/subtypes (hook_*, future additions) are ignored, never an error.
 * OBSERVED on the Legion (fixture print-stream-json.jsonl): system/init, assistant text, result.
 * ASSUMED, not yet observed (docs/ASSUMPTIONS.md): assistant `tool_use` blocks and user `tool_result` blocks.
 */
export function parseClaudeLine(line: string): ParsedLine {
  const none: ParsedLine = { events: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return none;
  }
  const e = obj(raw);
  if (!e) return none;

  if (e.type === "assistant" || e.type === "user") {
    const content = obj(e.message)?.content;
    if (!Array.isArray(content)) return none;
    const events: AgentEvent[] = [];
    for (const b of content) {
      const block = obj(b);
      if (!block) continue;
      if (e.type === "assistant" && block.type === "text" && typeof block.text === "string") {
        if (block.text.length > 0) events.push({ type: "text", content: block.text });
      } else if (e.type === "assistant" && block.type === "tool_use") {
        events.push({
          type: "tool_call",
          name: typeof block.name === "string" ? block.name : "unknown",
          args: block.input,
          ...(typeof block.id === "string" && block.id ? { callId: block.id } : {}),
        });
      } else if (e.type === "user" && block.type === "tool_result") {
        events.push({
          type: "tool_result",
          result: block.content,
          ...(typeof block.tool_use_id === "string" && block.tool_use_id
            ? { callId: block.tool_use_id }
            : {}),
        });
      }
    }
    return { events };
  }

  if (e.type === "result") {
    const events: AgentEvent[] = [];
    if (e.usage !== undefined || e.total_cost_usd !== undefined) {
      events.push({
        type: "usage",
        data: { usage: e.usage, totalCostUsd: e.total_cost_usd, numTurns: e.num_turns },
      });
    }
    if (e.is_error === true) {
      const errors = Array.isArray(e.errors) ? e.errors.filter((x) => typeof x === "string") : [];
      const message =
        errors.length > 0
          ? errors.join("; ")
          : typeof e.result === "string" && e.result
            ? e.result
            : `claude reported ${String(e.subtype ?? "an error")}`;
      return { events, final: { type: "error", message } };
    }
    return {
      events,
      final: {
        type: "completed",
        ...(typeof e.session_id === "string" ? { sessionId: e.session_id } : {}),
      },
    };
  }
  return none;
}
