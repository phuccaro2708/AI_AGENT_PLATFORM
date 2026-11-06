import type { AgentMessage, SidecarEvent, TaskState } from "@agent-studio/contracts";

/** Live view of one task: messages by `sequence`, plus the last known state. */
export interface TaskLog {
  messages: AgentMessage[];
  state: TaskState | null;
}

export const emptyLog: TaskLog = { messages: [], state: null };

const TERMINAL: readonly TaskState[] = ["completed", "failed", "cancelled", "needs_reconciliation"];
export const isTerminal = (s: TaskState | null): boolean => s !== null && TERMINAL.includes(s);

/** Adds messages, de-duplicated by sequence and sorted (events and `logs.query` overlap). */
export function mergeMessages(log: TaskLog, incoming: AgentMessage[]): TaskLog {
  const bySeq = new Map(log.messages.map((m) => [m.sequence, m]));
  for (const m of incoming) bySeq.set(m.sequence, m);
  return { ...log, messages: [...bySeq.values()].sort((a, b) => a.sequence - b.sequence) };
}

export function applyEvent(log: TaskLog, e: SidecarEvent): TaskLog {
  if (e.event === "fatal") return log; // about the sidecar, not about any task
  return e.event === "task.message" ? mergeMessages(log, [e.message]) : { ...log, state: e.state };
}

/** Number of messages 0..n-1 held without a hole; a push may have been dropped beyond that. */
export function contiguousCount(log: TaskLog): number {
  let n = 0;
  for (const m of log.messages) {
    if (m.sequence !== n) break;
    n++;
  }
  return n;
}

export const hasGap = (log: TaskLog): boolean => contiguousCount(log) !== log.messages.length;

/** `afterSequence` for the `logs.query` that fills the holes. */
export const resyncCursor = (log: TaskLog): number => contiguousCount(log) - 1;

export interface Line {
  kind: "text" | "tool" | "info" | "error";
  text: string;
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);
const show = (v: unknown) => clip(typeof v === "string" ? v : (JSON.stringify(v) ?? ""));
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/** One display line per stored message. Payload shapes follow `AgentEvent`. */
export function describeMessage(m: AgentMessage): Line {
  const p = obj(m.payload);
  switch (m.type) {
    case "task.accepted":
      return { kind: "info", text: "Task started" };
    case "task.completed":
      return { kind: "info", text: "Completed" };
    case "task.failed":
      return { kind: "error", text: show(p.message ?? "Failed") };
    case "review.request": {
      const n = Array.isArray(p.artifacts) ? p.artifacts.length : 0;
      return { kind: "info", text: `Review requested: ${show(p.summary)} (${n} file(s))` };
    }
    case "review.result": {
      const comments = Array.isArray(p.comments) ? p.comments : [];
      const verdict =
        p.verdict === "approve"
          ? "Approved"
          : p.verdict === "request_changes"
            ? "Changes requested"
            : "Review result";
      const detail = comments.map((c) => `- ${show(c)}`).join("\n");
      return {
        kind: p.verdict === "approve" ? "info" : "error",
        text: detail ? `${verdict}\n${detail}` : verdict,
      };
    }
    case "approval.request":
      return { kind: "info", text: `Approval needed: ${show(p.description)}` };
    default:
      if (p.type === "text") return { kind: "text", text: show(p.content) };
      if (p.type === "tool_call") return { kind: "tool", text: `${show(p.name)}(${show(p.args)})` };
      if (p.type === "tool_result") return { kind: "tool", text: `→ ${show(p.result)}` };
      return { kind: "info", text: `${m.type}: ${show(m.payload)}` };
  }
}
