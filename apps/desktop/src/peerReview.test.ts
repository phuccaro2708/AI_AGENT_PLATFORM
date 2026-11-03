import { describe, expect, it } from "vitest";
import type { Approval, WorkflowTask } from "./api";
import {
  approvalText,
  approvalsFor,
  boardRows,
  diffTask,
  parseRuns,
  workflowDone,
} from "./peerReview";

const task = (id: string): WorkflowTask => ({
  id,
  agentId: "a",
  state: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
});
const approval = (id: string, taskId: string, state = "pending"): Approval => ({
  id,
  taskId,
  state,
  requestJson: '{"description":"merge it"}',
  expiresAt: null,
});

describe("peer review run logic", () => {
  it("alternates implementer and reviewer by round", () => {
    const rows = boardRows([task("1"), task("2"), task("3"), task("4")]);
    expect(rows.map((r) => [r.role, r.round])).toEqual([
      ["implementer", 1],
      ["reviewer", 1],
      ["implementer", 2],
      ["reviewer", 2],
    ]);
    expect(diffTask(rows)?.id).toBe("3");
    expect(diffTask([])).toBeUndefined();
  });
  it("knows which workflow states are final", () => {
    expect(workflowDone("completed")).toBe(true);
    expect(workflowDone("failed")).toBe(true);
    expect(workflowDone("running")).toBe(false);
  });
  it("only offers pending approvals of this run", () => {
    const list = [approval("a1", "1"), approval("a2", "9"), approval("a3", "1", "approved")];
    expect(approvalsFor(list, [task("1")]).map((a) => a.id)).toEqual(["a1"]);
    expect(approvalText(list[0]!)).toBe("merge it");
    expect(approvalText({ ...list[0]!, requestJson: "not json" })).toBe("not json");
  });
  it("ignores corrupt stored runs", () => {
    const ok = { workflowId: "w", projectId: "p", goal: "g", implementer: "i", reviewer: "r" };
    expect(parseRuns(JSON.stringify([ok, { workflowId: 1 }, null]))).toEqual([ok]);
    expect(parseRuns("{")).toEqual([]);
    expect(parseRuns(null)).toEqual([]);
  });
});
