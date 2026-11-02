import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import { classifyOutcome } from "./outcome.js";

const call: AgentEvent = { type: "tool_call", name: "t", args: {} };
const result: AgentEvent = { type: "tool_result", result: {} };
const text: AgentEvent = { type: "text", content: "x" };
const done: AgentEvent = { type: "completed" };
const err = (message: string): AgentEvent => ({ type: "error", message });

describe("classifyOutcome", () => {
  it("completed", () => {
    expect(classifyOutcome({ events: [text, call, result, done] }).state).toBe("completed");
  });
  it("plain error without unfinished tools is failed", () => {
    expect(classifyOutcome({ events: [text, err("boom")] })).toEqual({
      state: "failed",
      reason: "boom",
    });
  });
  it("cancelled with no tool in flight is cancelled", () => {
    expect(classifyOutcome({ events: [text, err("cancelled")] }).state).toBe("cancelled");
  });
  it("cancelled while a tool call has no result needs reconciliation", () => {
    const o = classifyOutcome({ events: [call, err("cancelled")] });
    expect(o.state).toBe("needs_reconciliation");
    expect(o.reason).toMatch(/1 tool call/);
  });
  it("error after an unfinished tool call needs reconciliation", () => {
    expect(classifyOutcome({ events: [call, err("crash")] }).state).toBe("needs_reconciliation");
  });
  it("counts calls and results (parallel tools)", () => {
    expect(classifyOutcome({ events: [call, call, result, err("x")] }).state).toBe(
      "needs_reconciliation",
    );
    expect(classifyOutcome({ events: [call, call, result, result, err("x")] }).state).toBe(
      "failed",
    );
  });
  it("stream ends without terminal: failed if nothing risky, reconciliation if a tool was running", () => {
    expect(classifyOutcome({ events: [text] }).state).toBe("failed");
    expect(classifyOutcome({ events: [] }).state).toBe("failed");
    expect(classifyOutcome({ events: [call] }).state).toBe("needs_reconciliation");
  });
  it("abnormal end (throw / invalid event) follows the same rule", () => {
    expect(classifyOutcome({ events: [text], abnormalEnd: "adapter threw: x" }).state).toBe(
      "failed",
    );
    expect(classifyOutcome({ events: [call], abnormalEnd: "adapter threw: x" }).state).toBe(
      "needs_reconciliation",
    );
  });
  it("events after the terminal event are ignored", () => {
    expect(classifyOutcome({ events: [done, call] }).state).toBe("completed");
  });
});
