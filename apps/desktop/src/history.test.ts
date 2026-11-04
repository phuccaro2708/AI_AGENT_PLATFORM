import { describe, expect, it } from "vitest";
import type { HistoryRow } from "./api";
import { agentsIn, hasOlder, pageRows, searchable, toFilter, whenText } from "./history";

const row = (agentId: string | null): HistoryRow => ({
  taskId: "t",
  workflowId: "w",
  projectId: "p",
  projectName: "P",
  agentId,
  state: "completed",
  attempt: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("history helpers", () => {
  it("drops empty filters and keeps paging", () => {
    expect(toFilter({ projectId: "", agentId: "", state: "", offset: 0 })).toEqual({
      limit: 31,
      offset: 0,
    });
    expect(toFilter({ projectId: "p", agentId: "claude", state: "failed", offset: 30 })).toEqual({
      projectId: "p",
      agentId: "claude",
      state: "failed",
      limit: 31,
      offset: 30,
    });
  });

  it("lists known and seen agents once, sorted, skipping tasks without an agent", () => {
    expect(agentsIn([row("codex"), row(null), row("claude")], ["claude", "stub"])).toEqual([
      "claude",
      "codex",
      "stub",
    ]);
  });

  it("shows a time for today and a date for other days; an invalid date stays as is", () => {
    const now = new Date("2026-06-10T12:00:00");
    expect(whenText("2026-06-10T08:05:00", now)).toMatch(/\d/);
    expect(whenText("2025-01-02T08:05:00", now)).toMatch(/2025/);
    expect(whenText("garbage", now)).toBe("garbage");
  });

  it("shows Older only when a row exists beyond the page", () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => i);
    expect(hasOlder(n(30))).toBe(false);
    expect(hasOlder(n(31))).toBe(true);
    expect(pageRows(n(31))).toHaveLength(30);
  });

  it("includes the time for other days", () => {
    const now = new Date("2026-06-10T12:00:00");
    expect(whenText("2025-01-02T08:05:00", now)).toMatch(/2025.*\d:\d\d/);
  });

  it("searches from two characters", () => {
    expect(searchable("a")).toBe(false);
    expect(searchable(" a ")).toBe(false);
    expect(searchable("ab")).toBe(true);
  });
});
