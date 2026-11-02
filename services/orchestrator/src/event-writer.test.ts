import { describe, expect, it } from "vitest";
import type { SidecarEvent } from "@agent-studio/contracts";
import { createEventWriter } from "./event-writer.js";

const msg = (sequence: number): SidecarEvent => ({
  event: "task.message",
  taskId: "t",
  sequence,
  message: {
    id: `m${sequence}`,
    schemaVersion: 1,
    workflowId: "w",
    taskId: "t",
    correlationId: "c",
    fromAgent: "a",
    toAgent: "orchestrator",
    type: "task.progress",
    payload: {},
    createdAt: new Date().toISOString(),
    sequence,
  },
});
const state: SidecarEvent = { event: "task.state", taskId: "t", state: "completed" };

describe("createEventWriter backpressure", () => {
  it("writes one JSON line per event while the reader keeps up", () => {
    const lines: string[] = [];
    const w = createEventWriter({ write: (l) => lines.push(l), pending: () => 0 });
    w.emit(msg(0));
    w.emit(state);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "task.message", sequence: 0 });
  });
  it("drops messages (counted) but never task.state when the reader is slow", () => {
    const lines: string[] = [];
    const w = createEventWriter({ write: (l) => lines.push(l), pending: () => 10, maxPending: 5 });
    w.emit(msg(0));
    w.emit(msg(1));
    w.emit(state);
    expect(w.dropped()).toBe(2);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "task.state" });
  });
});
