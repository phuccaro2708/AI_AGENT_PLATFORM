import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  AgentTaskInput,
  WORKFLOW_TRANSITIONS,
  WorkflowState,
  canTransitionWorkflow,
  isTerminalWorkflowState,
  parseMessagePayload,
} from "./index.js";

describe("AgentTaskInput.permissions", () => {
  const base = { id: "t", prompt: "p", cwd: "/w" };
  it("is optional and accepts the two modes only", () => {
    expect(AgentTaskInput.safeParse(base).success).toBe(true);
    expect(AgentTaskInput.safeParse({ ...base, permissions: "read-only" }).success).toBe(true);
    expect(AgentTaskInput.safeParse({ ...base, permissions: "workspace-write" }).success).toBe(
      true,
    );
    expect(AgentTaskInput.safeParse({ ...base, permissions: "full" }).success).toBe(false);
  });
});

describe("AgentEvent callId", () => {
  it("is optional on tool_call and tool_result", () => {
    expect(AgentEvent.safeParse({ type: "tool_call", name: "x", args: {} }).success).toBe(true);
    expect(
      AgentEvent.safeParse({ type: "tool_call", name: "x", args: {}, callId: "c1" }).success,
    ).toBe(true);
    expect(AgentEvent.safeParse({ type: "tool_result", result: 1, callId: "c1" }).success).toBe(
      true,
    );
    expect(AgentEvent.safeParse({ type: "tool_result", result: 1, callId: "" }).success).toBe(
      false,
    );
  });
});

describe("workflow state machine", () => {
  it("covers every state and allows the expected edges", () => {
    for (const s of WorkflowState.options) expect(WORKFLOW_TRANSITIONS[s]).toBeDefined();
    expect(canTransitionWorkflow("pending", "running")).toBe(true);
    expect(canTransitionWorkflow("running", "paused")).toBe(true);
    expect(canTransitionWorkflow("paused", "running")).toBe(true);
    expect(canTransitionWorkflow("running", "completed")).toBe(true);
  });
  it("terminal states have no way out and pending cannot jump to completed", () => {
    for (const s of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminalWorkflowState(s)).toBe(true);
      for (const to of WorkflowState.options) expect(canTransitionWorkflow(s, to)).toBe(false);
    }
    expect(canTransitionWorkflow("pending", "completed")).toBe(false);
  });
});

describe("parseMessagePayload", () => {
  it("validates review.request with artifact hashes", () => {
    const ok = parseMessagePayload("review.request", {
      summary: "implemented X",
      artifacts: [{ path: "src/a.ts", sha256: "a".repeat(64) }],
    });
    expect(ok.success).toBe(true);
    const bad = parseMessagePayload("review.request", {
      summary: "x",
      artifacts: [{ path: "src/a.ts", sha256: "short" }],
    });
    expect(bad.success).toBe(false);
  });
  it("validates review.result verdicts", () => {
    expect(parseMessagePayload("review.result", { verdict: "approve", comments: [] }).success).toBe(
      true,
    );
    expect(parseMessagePayload("review.result", { verdict: "maybe", comments: [] }).success).toBe(
      false,
    );
  });
  it("validates approval.request and agent.message", () => {
    expect(
      parseMessagePayload("approval.request", { approvalId: "a1", description: "write file" })
        .success,
    ).toBe(true);
    expect(parseMessagePayload("agent.message", { text: "hi" }).success).toBe(true);
    expect(parseMessagePayload("agent.message", {}).success).toBe(false);
  });
  it("leaves free-form task.* payloads unconstrained", () => {
    expect(parseMessagePayload("task.progress", { anything: 1 }).success).toBe(true);
  });
});
