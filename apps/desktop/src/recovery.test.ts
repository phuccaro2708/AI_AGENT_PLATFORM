import { describe, expect, it } from "vitest";
import type { RecoveryReport } from "./api";
import { evidenceSummary, recoveryBlocker } from "./recovery";

const report = (over: Partial<RecoveryReport> = {}): RecoveryReport => ({
  taskId: "t",
  state: "needs_reconciliation",
  attempt: 0,
  classification: "side_effects_unverified",
  evidence: {
    messageCount: 3,
    producedOutput: true,
    toolCalls: 1,
    unfinishedToolCalls: 1,
    hasStoredPrompt: true,
    hasWorktree: true,
    worktreeChanged: true,
    flaggedByPolicy: false,
  },
  actions: {
    resume: { allowed: true, confirmation: true },
    retry: { allowed: true, confirmation: true },
    abandon: { allowed: true, confirmation: false },
  },
  ...over,
});

describe("recoveryBlocker", () => {
  it("waits for the report, a choice and a note", () => {
    expect(recoveryBlocker(null, "retry", "checked it", true)).toMatch(/Loading/);
    expect(recoveryBlocker(report(), null, "checked it", true)).toMatch(/Choose/);
    expect(recoveryBlocker(report(), "abandon", " x ", false)).toMatch(/what you checked/);
  });

  it("asks for confirmation only where the sidecar will", () => {
    expect(recoveryBlocker(report(), "retry", "checked it", false)).toMatch(/Confirm/);
    expect(recoveryBlocker(report(), "retry", "checked it", true)).toBeNull();
    expect(recoveryBlocker(report(), "abandon", "checked it", false)).toBeNull();
  });

  it("shows why an action is not available", () => {
    const r = report({
      actions: {
        resume: { allowed: false, confirmation: true, why: "nothing to continue from" },
        retry: { allowed: true, confirmation: false },
        abandon: { allowed: true, confirmation: false },
      },
    });
    expect(recoveryBlocker(r, "resume", "checked it", true)).toBe("nothing to continue from");
    expect(recoveryBlocker(r, "retry", "checked it", false)).toBeNull();
  });
});

describe("evidenceSummary", () => {
  it("describes tool calls and the worktree", () => {
    expect(evidenceSummary(report())).toBe(
      "1 tool call(s), 1 without a result · worktree has changes",
    );
    const clean = report({
      evidence: { ...report().evidence, toolCalls: 0, unfinishedToolCalls: 0, hasWorktree: false },
    });
    expect(evidenceSummary(clean)).toBe("no tool calls recorded · no worktree");
  });
});
