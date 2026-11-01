import { describe, expect, it } from "vitest";
import { AgentEvent, AgentMessage, TaskState, WorkflowState } from "./index.js";

const validMessage = {
  id: "m1",
  schemaVersion: 1,
  workflowId: "wf1",
  taskId: "t1",
  correlationId: "c1",
  fromAgent: "stub",
  toAgent: "orchestrator",
  type: "task.progress",
  payload: { pct: 1 },
  createdAt: "2026-11-01T00:00:00.000Z",
  sequence: 0,
};

describe("AgentMessage", () => {
  it("accepts a valid message", () => {
    expect(AgentMessage.safeParse(validMessage).success).toBe(true);
  });
  it("rejects unknown schemaVersion, type, negative sequence, bad date", () => {
    expect(AgentMessage.safeParse({ ...validMessage, schemaVersion: 2 }).success).toBe(false);
    expect(AgentMessage.safeParse({ ...validMessage, type: "nope" }).success).toBe(false);
    expect(AgentMessage.safeParse({ ...validMessage, sequence: -1 }).success).toBe(false);
    expect(AgentMessage.safeParse({ ...validMessage, createdAt: "yesterday" }).success).toBe(false);
  });
});

describe("AgentEvent", () => {
  it("accepts each event kind", () => {
    for (const e of [
      { type: "text", content: "hi" },
      { type: "tool_call", name: "x", args: {} },
      { type: "completed" },
      { type: "error", message: "boom" },
    ]) {
      expect(AgentEvent.safeParse(e).success).toBe(true);
    }
  });
  it("rejects unknown type and missing fields", () => {
    expect(AgentEvent.safeParse({ type: "other" }).success).toBe(false);
    expect(AgentEvent.safeParse({ type: "text" }).success).toBe(false);
  });
});

describe("states", () => {
  it("match the database CHECK constraints", () => {
    expect(TaskState.options).toContain("needs_reconciliation");
    expect(WorkflowState.options).toHaveLength(6);
  });
});
