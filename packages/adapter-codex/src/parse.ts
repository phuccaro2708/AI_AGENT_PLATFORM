import type { AgentEvent } from "@agent-studio/contracts";

/** What one stdout line of `codex exec --json` means for us. */
export interface ParsedLine {
  events: AgentEvent[];
  /** Set by `turn.completed` / `turn.failed`: the run is over and this is how it ended. */
  final?: AgentEvent;
}

export interface CodexParser {
  parse(line: string): ParsedLine;
  /** Last `error` message seen, for a run that ends without a terminal line. */
  lastError(): string | undefined;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * Stateful (thread id, which items already emitted their tool_call) but otherwise pure mapper.
 * OBSERVED on the Legion with codex-cli 0.165.0 (fixtures exec-json-*.jsonl): thread.started,
 * turn.started, item.started/item.completed for `agent_message` and `command_execution`,
 * turn.completed with usage.
 * ASSUMED, not observed (docs/ASSUMPTIONS.md): `turn.failed`, top-level `error`, and every other
 * item type. Any unknown item type except reasoning is treated as a tool, so a started-but-never-
 * finished item still counts as an unverified side effect (needs_reconciliation).
 */
export function createCodexParser(): CodexParser {
  let threadId: string | undefined;
  let lastError: string | undefined;
  const started = new Set<string>();

  const toolName = (type: string) => (type === "command_execution" ? "shell" : type);
  const toolArgs = (item: Record<string, unknown>) =>
    item.type === "command_execution" ? { command: item.command } : item;

  const parse = (line: string): ParsedLine => {
    const none: ParsedLine = { events: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return none;
    }
    const e = obj(raw);
    if (!e) return none;

    switch (e.type) {
      case "thread.started":
        if (typeof e.thread_id === "string") threadId = e.thread_id;
        return none;

      case "item.started":
      case "item.completed": {
        const item = obj(e.item);
        if (!item || typeof item.type !== "string") return none;
        if (item.type === "reasoning") return none;
        if (item.type === "agent_message") {
          return e.type === "item.completed" && typeof item.text === "string" && item.text !== ""
            ? { events: [{ type: "text", content: item.text }] }
            : none;
        }
        if (item.type === "error") {
          if (typeof item.message === "string") lastError = item.message;
          return none;
        }
        const id = typeof item.id === "string" ? item.id : undefined;
        const events: AgentEvent[] = [];
        if (id === undefined || !started.has(id)) {
          events.push({
            type: "tool_call",
            name: toolName(item.type),
            args: toolArgs(item),
            ...(id !== undefined && id !== "" ? { callId: id } : {}),
          });
          if (id !== undefined) started.add(id);
        }
        if (e.type === "item.completed") {
          events.push({
            type: "tool_result",
            ...(id !== undefined && id !== "" ? { callId: id } : {}),
            result:
              item.type === "command_execution"
                ? {
                    exitCode: item.exit_code,
                    status: item.status,
                    output: item.aggregated_output,
                  }
                : item,
          });
        }
        return { events };
      }

      case "turn.completed":
        return {
          events: e.usage !== undefined ? [{ type: "usage", data: e.usage }] : [],
          final: { type: "completed", ...(threadId ? { sessionId: threadId } : {}) },
        };

      case "turn.failed": {
        const message = obj(e.error)?.message;
        return {
          events: [],
          final: {
            type: "error",
            message:
              typeof message === "string" && message
                ? message
                : (lastError ?? "codex reported turn.failed"),
          },
        };
      }

      case "error":
        if (typeof e.message === "string") lastError = e.message;
        return none;

      default:
        return none;
    }
  };

  return { parse, lastError: () => lastError };
}
