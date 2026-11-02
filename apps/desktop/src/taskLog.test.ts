import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@agent-studio/contracts";
import {
  applyEvent,
  describeMessage,
  emptyLog,
  hasGap,
  isTerminal,
  mergeMessages,
  resyncCursor,
} from "./taskLog";

const msg = (
  sequence: number,
  type: AgentMessage["type"] = "task.progress",
  payload: unknown = {},
) =>
  ({
    id: `m${sequence}`,
    schemaVersion: 1,
    workflowId: "w",
    taskId: "t",
    correlationId: "c",
    fromAgent: "a",
    toAgent: "orchestrator",
    type,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
    sequence,
  }) as AgentMessage;
const push = (m: AgentMessage) =>
  ({ event: "task.message", taskId: "t", sequence: m.sequence, message: m }) as const;

describe("task log", () => {
  it("orders by sequence and ignores duplicates", () => {
    let l = mergeMessages(emptyLog, [msg(1), msg(0)]);
    l = mergeMessages(l, [msg(1), msg(2)]);
    expect(l.messages.map((m) => m.sequence)).toEqual([0, 1, 2]);
    expect(hasGap(l)).toBe(false);
  });
  it("detects a dropped push and points the resync after the last contiguous message", () => {
    let l = applyEvent(emptyLog, push(msg(0)));
    l = applyEvent(l, push(msg(1)));
    l = applyEvent(l, push(msg(4))); // 2 and 3 were dropped under backpressure
    expect(hasGap(l)).toBe(true);
    expect(resyncCursor(l)).toBe(1);
    l = mergeMessages(l, [msg(2), msg(3)]); // what logs.query returns
    expect(hasGap(l)).toBe(false);
    expect(resyncCursor(l)).toBe(4);
  });
  it("a log that does not start at 0 counts as a gap; an empty log resyncs from -1", () => {
    expect(hasGap(mergeMessages(emptyLog, [msg(3)]))).toBe(true);
    expect(resyncCursor(emptyLog)).toBe(-1);
  });
  it("tracks state from events", () => {
    const l = applyEvent(emptyLog, { event: "task.state", taskId: "t", state: "cancelled" });
    expect(l.state).toBe("cancelled");
    expect(isTerminal(l.state)).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal(null)).toBe(false);
  });
  it("describes each message kind without throwing on odd payloads", () => {
    expect(describeMessage(msg(0, "task.progress", { type: "text", content: "hi" }))).toEqual({
      kind: "text",
      text: "hi",
    });
    expect(
      describeMessage(msg(0, "task.progress", { type: "tool_call", name: "Read", args: { a: 1 } }))
        .text,
    ).toBe('Read({"a":1})');
    expect(describeMessage(msg(0, "task.failed", { type: "error", message: "boom" }))).toEqual({
      kind: "error",
      text: "boom",
    });
    expect(describeMessage(msg(0, "task.progress", null)).kind).toBe("info");
    expect(
      describeMessage(msg(0, "task.progress", { type: "text", content: "x".repeat(1000) })).text,
    ).toHaveLength(301);
  });
});
