import { describe, expect, it } from "vitest";
import {
  CLI_NAME,
  ProcessTracker,
  descendantsOf,
  parseProcessLines,
  renderTable,
  type ProcInfo,
} from "./real-cli-metrics";

const p = (pid: number, ppid: number, name: string, created = "t0"): ProcInfo => ({
  pid,
  ppid,
  created,
  name,
});

describe("real-cli soak metrics helpers", () => {
  it("parses process lines and skips malformed ones", () => {
    const rows = parseProcessLines(
      "10|1|2026-01-01T00:00:00|node.exe\r\nbad\nx|y|z|w\n11|10|c|a|b.exe",
    );
    expect(rows).toEqual([p(10, 1, "node.exe", "2026-01-01T00:00:00"), p(11, 10, "a|b.exe", "c")]);
  });

  it("finds descendants transitively and ignores unrelated processes and cycles", () => {
    const procs = [p(2, 1, "a"), p(3, 2, "b"), p(4, 3, "c"), p(9, 8, "other"), p(1, 4, "cycle")];
    expect(descendantsOf(1, procs).map((x) => x.pid)).toEqual([2, 3, 4]);
  });

  it("reports a seen process as survivor only with the same pid and creation time", () => {
    const t = new ProcessTracker(1) as unknown as {
      seen: Map<string, ProcInfo & { during: string[] }>;
      survivors(a: ProcInfo[]): ProcInfo[];
    };
    t.seen.set("5@a", { ...p(5, 1, "claude.exe", "a"), during: ["wf1"] });
    t.seen.set("6@a", { ...p(6, 1, "codex.exe", "a"), during: ["wf1"] });
    const alive = [p(5, 1, "claude.exe", "a"), p(6, 99, "node.exe", "other-start")];
    expect(t.survivors(alive).map((x) => x.pid)).toEqual([5]);
  });

  it("matches CLI names only", () => {
    for (const n of ["claude.exe", "codex", "node.exe", "bun"]) expect(CLI_NAME.test(n)).toBe(true);
    for (const n of ["git.exe", "conhost.exe", "powershell.exe"])
      expect(CLI_NAME.test(n)).toBe(false);
  });

  it("renders a table with one row per workflow", () => {
    const md = renderTable([
      {
        n: 1,
        workflowId: "wf",
        kind: "plain",
        agent: "a",
        workflowState: "completed",
        ms: 5,
        taskCount: 1,
        taskStates: ["completed"],
        orphansAfter: 0,
      },
    ]);
    expect(md.split("\n")).toHaveLength(3);
    expect(md).toContain("| 1 | wf | plain | a | completed | 5 | 1 | completed | 0 |");
  });
});
