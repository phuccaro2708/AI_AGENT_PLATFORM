import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { ContextBoard, renderBoard, type RoleDef } from "./index.js";

const role = (sees: RoleDef["sees"]): RoleDef => ({
  name: "r",
  instructions: "i",
  access: "read",
  allowedAgents: "any",
  sees,
});

let dir: string;
let db: StudioDb;
let repo: Repo;
let wf: string;
let board: ContextBoard;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-board-"));
  db = openDatabase(join(dir, "b.db"));
  runMigrations(db);
  repo = new Repo(db);
  wf = repo.createWorkflow(repo.createProject("p", "/p"));
  board = new ContextBoard(repo);
  board.add(wf, { kind: "goal", source: "user", content: "GOAL-TEXT" });
  board.add(wf, { kind: "plan", source: "agent-reported", content: "PLAN-TEXT" });
  board.add(wf, { kind: "decision", source: "agent-reported", content: "DECISION-TEXT" });
  board.add(wf, { kind: "report", source: "agent-reported", content: "REPORT-TEXT" });
  board.add(wf, {
    kind: "artifact",
    source: "verified",
    content: "",
    path: "src/x.ts",
    sha256: "ab".repeat(32),
  });
  board.add(wf, { kind: "artifact", source: "verified", content: "deleted", path: "old.ts" });
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ContextBoard.render (role-filtered view)", () => {
  it("shows a role only the kinds it is allowed to see", () => {
    const text = board.render(wf, role(["goal", "artifact"]));
    expect(text).toContain("GOAL-TEXT");
    expect(text).toContain("src/x.ts");
    for (const hidden of ["PLAN-TEXT", "DECISION-TEXT", "REPORT-TEXT"])
      expect(text).not.toContain(hidden);
  });

  it("a role that sees nothing gets an empty string (no header leaking structure)", () => {
    expect(board.render(wf, role([]))).toBe("");
  });

  it("labels every entry with its source, artifacts with a short hash, and marks deletions", () => {
    const text = board.render(wf, role(["goal", "plan", "report", "artifact"]));
    expect(text).toMatch(/GOAL-TEXT/);
    expect(text).toMatch(/\[user\][^\n]*GOAL-TEXT/);
    expect(text).toMatch(/\[agent-reported\][^\n]*PLAN-TEXT/);
    expect(text).toMatch(/\[verified\][^\n]*src\/x\.ts[^\n]*abababab/);
    expect(text).toMatch(/\[verified\][^\n]*old\.ts[^\n]*deleted/);
  });

  it("frames other agents' content as data, not instructions", () => {
    expect(board.render(wf, role(["goal"]))).toMatch(/not instructions/i);
  });

  it("does not leak entries of another workflow", () => {
    const w2 = repo.createWorkflow(repo.createProject("q", "/q"));
    board.add(w2, { kind: "goal", source: "user", content: "OTHER-GOAL" });
    const text = board.render(wf, role(["goal"]));
    expect(text).not.toContain("OTHER-GOAL");
  });
});

describe("renderBoard", () => {
  it("truncates oversized entries", () => {
    const big = "x".repeat(10_000);
    const text = renderBoard(
      [{ kind: "report", source: "agent-reported", content: big, path: null, sha256: null }],
      role(["report"]),
    );
    expect(text.length).toBeLessThan(5000);
    expect(text).toMatch(/truncated/i);
  });
});
