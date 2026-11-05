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

/** `system/permission_denied` and `result.permission_denials[]` describe the same event; the adapter dedupes by callId. */
function denial(tool: unknown, id: unknown, input: unknown, reason: unknown): AgentEvent {
  return {
    type: "permission_denied",
    toolName: typeof tool === "string" && tool ? tool : "unknown",
    ...(typeof id === "string" && id ? { callId: id } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(typeof reason === "string" && reason ? { reason } : {}),
  };
}

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

  if (e.type === "system" && e.subtype === "permission_denied") {
    return { events: [denial(e.tool_name, e.tool_use_id, undefined, e.decision_reason)] };
  }

  if (e.type === "result") {
    const events: AgentEvent[] = [];
    if (Array.isArray(e.permission_denials)) {
      for (const d of e.permission_denials) {
        const o = obj(d);
        if (o) events.push(denial(o.tool_name, o.tool_use_id, o.tool_input, undefined));
      }
    }
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
