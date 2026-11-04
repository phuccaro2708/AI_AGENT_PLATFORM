import type { AgentEvent } from "@agent-studio/contracts";

export interface ParsedLine {
  events: AgentEvent[];
  final?: AgentEvent;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

export interface AntigravityParser {
  parse(line: string): ParsedLine;
}

/**
 * Parses `agy --print --output-format stream-json` (Antigravity 1.4.8). Only events seen in the
 * fixtures are mapped: `init`, `step_update` (agent_response text deltas) and `result`.
 * Unknown events are ignored, never an error.
 *
 * A `result` counts as success only when status is SUCCESS, `num_turns > 0` and `response` is
 * non-empty: `--mode plan` was observed to exit 0 with an empty result (see ASSUMPTIONS.md).
 * No tool_call events are emitted because none have been observed.
 */
export function createAntigravityParser(): AntigravityParser {
  return {
    parse(line: string): ParsedLine {
      const none: ParsedLine = { events: [] };
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return none;
      }
      const e = obj(raw);
      if (!e) return none;

      if (e.event === "step_update") {
        const s = obj(e.step_update);
        if (s?.step_type === "agent_response" && typeof s.text_delta === "string") {
          if (s.text_delta !== "") return { events: [{ type: "text", content: s.text_delta }] };
        }
        return none;
      }

      if (e.event === "result") {
        const r = obj(e.result);
        if (!r)
          return { events: [], final: { type: "error", message: "agy sent an empty result" } };
        const events: AgentEvent[] = [];
        const usage = obj(r.usage);
        if (usage) {
          events.push({
            type: "usage",
            data: {
              usage,
              ...(typeof r.num_turns === "number" ? { numTurns: r.num_turns } : {}),
            },
          });
        }
        const response = typeof r.response === "string" ? r.response : "";
        const turns = typeof r.num_turns === "number" ? r.num_turns : 0;
        if (r.status !== "SUCCESS") {
          return {
            events,
            final: { type: "error", message: `agy reported status ${String(r.status)}` },
          };
        }
        if (turns <= 0) {
          return {
            events,
            final: { type: "error", message: "agy finished with num_turns=0 (no model turn ran)" },
          };
        }
        if (response.trim() === "") {
          return {
            events,
            final: { type: "error", message: "agy finished with an empty response" },
          };
        }
        return { events, final: { type: "completed" } };
      }

      return none;
    },
  };
}
