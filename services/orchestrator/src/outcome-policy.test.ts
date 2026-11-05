import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import { classifyOutcome } from "./outcome.js";

describe("classifyOutcome with the policy gate's verdict", () => {
  it("an error flagged needsReconciliation is needs_reconciliation with its message as the reason", () => {
    const events: AgentEvent[] = [
      { type: "text", content: "done" },
      {
        type: "error",
        message: "changes outside the granted scope (1): x.txt",
        needsReconciliation: true,
      },
    ];
    expect(classifyOutcome({ events })).toEqual({
      state: "needs_reconciliation",
      reason: "changes outside the granted scope (1): x.txt",
    });
  });

  it("a plain error is still failed", () => {
    expect(classifyOutcome({ events: [{ type: "error", message: "boom" }] }).state).toBe("failed");
  });

  it("needsReconciliation: false does not change a failure", () => {
    const events: AgentEvent[] = [{ type: "error", message: "boom", needsReconciliation: false }];
    expect(classifyOutcome({ events }).state).toBe("failed");
  });

  it("a reported permission denial alone is not a reason to reconcile", () => {
    const events: AgentEvent[] = [
      { type: "permission_denied", toolName: "Write", callId: "c1" },
      { type: "completed" },
    ];
    expect(classifyOutcome({ events }).state).toBe("completed");
  });
});
