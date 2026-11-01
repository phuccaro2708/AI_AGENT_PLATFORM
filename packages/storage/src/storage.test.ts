import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, Repo, type StudioDb } from "./index.js";

let dir: string;
let db: StudioDb;
let repo: Repo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-test-"));
  db = openDatabase(join(dir, "test.db")); // file DB: WAL does not apply to :memory:
  runMigrations(db);
  repo = new Repo(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const seed = () => {
  const p = repo.createProject("demo", "/p");
  const w = repo.createWorkflow(p);
  return { p, w, t: repo.createTask(w, "stub") };
};
const msg = (taskId: string, id: string) => ({
  id,
  schemaVersion: 1 as const,
  workflowId: "wf",
  taskId,
  correlationId: "c",
  fromAgent: "stub",
  toAgent: "orchestrator",
  type: "task.progress" as const,
  payload: { n: 1 },
  createdAt: new Date().toISOString(),
});

describe("migrations & pragmas", () => {
  it("applies on an empty DB and is idempotent", () => {
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    const tables = db.$client
      .prepare(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '\\_\\_%' escape '\\'",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      "projects",
      "workflows",
      "tasks",
      "task_dependencies",
      "messages",
      "events",
      "settings",
    ]) {
      expect(tables).toContain(t);
    }
  });
  it("uses WAL and enforces foreign keys", () => {
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => repo.createWorkflow("missing-project")).toThrow();
  });
});

describe("constraints", () => {
  it("rejects invalid task state and self-dependency", () => {
    const { t } = seed();
    expect(() => db.$client.prepare("update tasks set state='bogus' where id=?").run(t)).toThrow();
    expect(() =>
      db.$client.prepare("insert into task_dependencies values (?,?)").run(t, t),
    ).toThrow();
  });
  it("enforces unique (task_id, sequence)", () => {
    const { t } = seed();
    repo.appendMessage(msg(t, "m1"), 0);
    expect(() => repo.appendMessage(msg(t, "m2"), 0)).toThrow();
    repo.appendMessage(msg(t, "m3"), 1);
    expect(repo.listMessages(t).map((m) => m.sequence)).toEqual([0, 1]);
  });
});

describe("Repo", () => {
  it("changes task state and writes the audit event atomically", () => {
    const { t } = seed();
    repo.setTaskState(t, "running");
    expect(repo.getTaskState(t)).toBe("running");
    expect(repo.listEvents(t)).toHaveLength(1);
  });
  it("persists across reopen (restart)", () => {
    const { t } = seed();
    repo.setTaskState(t, "needs_reconciliation");
    db.$client.close();
    db = openDatabase(join(dir, "test.db"));
    repo = new Repo(db);
    expect(repo.getTaskState(t)).toBe("needs_reconciliation");
  });
  it("does not leave an event behind when the state update fails", () => {
    expect(() => repo.setTaskState("nope", "running")).toThrow();
    expect(repo.listEvents("nope")).toHaveLength(0);
  });
});
