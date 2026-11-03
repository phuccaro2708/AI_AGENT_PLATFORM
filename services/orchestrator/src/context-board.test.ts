import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { ContextBoard, ContextLimitError } from "./context-board.js";

let dir: string;
let db: StudioDb;
let repo: Repo;
let wf: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-board-"));
  db = openDatabase(join(dir, "test.db"));
  runMigrations(db);
  repo = new Repo(db);
  wf = repo.createWorkflow(repo.createProject("demo", "/p"));
  repo.upsertRole({
    workflowId: wf,
    name: "implementer",
    instructions: "write code",
    permissions: "workspace-write",
    allowedAgents: ["claude"],
    visibleKinds: ["goal", "plan", "decision"],
  });
  repo.upsertRole({
    workflowId: wf,
    name: "reviewer",
    instructions: "review only",
    permissions: "read-only",
    allowedAgents: ["codex"],
    visibleKinds: ["goal", "artifact"],
  });
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha = "b".repeat(64);
const seed = (board: ContextBoard) => {
  board.add({
    workflowId: wf,
    kind: "goal",
    content: "ship feature X",
    source: "verified",
    createdBy: "user",
  });
  board.add({
    workflowId: wf,
    kind: "plan",
    content: "PLAN-SECRET-FOR-IMPLEMENTER",
    source: "agent_reported",
    createdBy: "claude",
  });
  board.add({
    workflowId: wf,
    kind: "artifact",
    content: "patch",
    path: "src/x.ts",
    sha256: sha,
    source: "verified",
    createdBy: "orchestrator",
  });
};

describe("ContextBoard.renderFor", () => {
  it("gives each role only the kinds it may see", () => {
    const board = new ContextBoard(repo);
    seed(board);
    const impl = board.renderFor(wf, "implementer");
    expect(impl.text).toContain("ship feature X");
    expect(impl.text).toContain("PLAN-SECRET-FOR-IMPLEMENTER");
    expect(impl.text).not.toContain("src/x.ts");
    const rev = board.renderFor(wf, "reviewer");
    expect(rev.text).toContain("ship feature X");
    expect(rev.text).toContain("src/x.ts");
    expect(rev.text).toContain(sha);
    expect(rev.text).not.toContain("PLAN-SECRET-FOR-IMPLEMENTER");
    expect(rev.itemIds).toHaveLength(2);
  });

  it("labels provenance and marks agent-reported content as untrusted data", () => {
    const board = new ContextBoard(repo);
    seed(board);
    const impl = board.renderFor(wf, "implementer");
    expect(impl.text).toMatch(/\[verified\][^\n]*ship feature X/);
    expect(impl.text).toMatch(/\[agent-reported\][^\n]*PLAN-SECRET/);
    expect(impl.text).toMatch(/not instructions/i);
  });

  it("fails for a role that does not exist rather than showing everything", () => {
    const board = new ContextBoard(repo);
    seed(board);
    expect(() => board.renderFor(wf, "ghost")).toThrow(/Unknown role/);
  });

  it("keeps the newest items within the character budget and says what was left out", () => {
    const board = new ContextBoard(repo, { maxRenderChars: 400 });
    for (let i = 0; i < 6; i++) {
      board.add({
        workflowId: wf,
        kind: "goal",
        content: `goal-${i} ${"x".repeat(80)}`,
        source: "verified",
        createdBy: "user",
      });
    }
    const r = board.renderFor(wf, "reviewer");
    expect(r.text.length).toBeLessThanOrEqual(400);
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.text).toContain("goal-5");
    expect(r.text).not.toContain("goal-0");
    expect(r.text).toMatch(/omitted/);
  });
});

describe("ContextBoard.add limits", () => {
  it("rejects an oversized item and a full board, and stores nothing", () => {
    const board = new ContextBoard(repo, { maxItemChars: 10, maxItems: 2 });
    const item = (content: string) => ({
      workflowId: wf,
      kind: "goal" as const,
      content,
      source: "verified" as const,
      createdBy: "u",
    });
    expect(() => board.add(item("x".repeat(11)))).toThrow(ContextLimitError);
    board.add(item("a"));
    board.add(item("b"));
    expect(() => board.add(item("c"))).toThrow(ContextLimitError);
    expect(repo.listContextItems(wf)).toHaveLength(2);
  });
});
