import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IllegalTransitionError } from "@agent-studio/contracts";
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
      "sessions",
      "execution_runs",
      "artifacts",
      "approvals",
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

describe("crash recovery (D4)", () => {
  it("moves running/waiting_approval tasks to needs_reconciliation, never retries, leaves others", () => {
    const { w, t: running } = seed();
    repo.setTaskState(running, "running");
    const waiting = repo.createTask(w, "stub");
    repo.setTaskState(waiting, "running");
    repo.setTaskState(waiting, "waiting_approval");
    const queued = repo.createTask(w, "stub");
    const done = repo.createTask(w, "stub");
    repo.setTaskState(done, "running");
    repo.setTaskState(done, "completed");

    const recovered = repo.recoverInterruptedTasks();

    expect(recovered.sort()).toEqual([running, waiting].sort());
    expect(repo.getTaskState(running)).toBe("needs_reconciliation");
    expect(repo.getTaskState(waiting)).toBe("needs_reconciliation");
    expect(repo.getTaskState(queued)).toBe("queued");
    expect(repo.getTaskState(done)).toBe("completed");
    expect(repo.getTaskAttempt(running)).toBe(0); // no automatic retry
    const last = repo.listEvents(running).at(-1);
    expect(JSON.parse(last?.payloadJson ?? "{}")).toMatchObject({
      from: "running",
      state: "needs_reconciliation",
    });
  });
  it("is a no-op when nothing was interrupted", () => {
    seed();
    expect(repo.recoverInterruptedTasks()).toEqual([]);
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
  it("enforces constraints on the Phase 1 tables", () => {
    const { t } = seed();
    const ts = new Date().toISOString();
    const bad = (sql: string, ...args: unknown[]) =>
      expect(() => db.$client.prepare(sql).run(...args)).toThrow();
    bad(
      "insert into approvals (id,task_id,state,request_json,created_at) values ('a',?,'maybe','{}',?)",
      t,
      ts,
    );
    bad(
      "insert into approvals (id,task_id,request_json,created_at) values ('a','nope','{}',?)",
      ts,
    );
    bad("insert into artifacts values ('x',?,'f.txt','short',?)", t, ts);
    bad("insert into execution_runs (id,task_id,started_at) values ('r','nope',?)", ts);
    db.$client
      .prepare("insert into approvals (id,task_id,request_json,created_at) values ('a',?,'{}',?)")
      .run(t, ts);
    expect(db.$client.prepare("select state from approvals where id='a'").get()).toEqual({
      state: "pending",
    });
  });
  it("records execution runs", () => {
    const { t } = seed();
    const run = repo.startRun(t, { pid: 4242, attempt: 0 });
    repo.finishRun(run, { exitCode: 0, signal: null });
    expect(repo.getRun(run)).toMatchObject({ taskId: t, pid: 4242, exitCode: 0, signal: null });
    expect(repo.getRun(run)?.endedAt).toBeTruthy();
    expect(() => repo.finishRun("nope", { exitCode: 1, signal: null })).toThrow();
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
    repo.setTaskState(t, "running");
    repo.setTaskState(t, "needs_reconciliation");
    db.$client.close();
    db = openDatabase(join(dir, "test.db"));
    repo = new Repo(db);
    expect(repo.getTaskState(t)).toBe("needs_reconciliation");
  });
  it("rejects illegal transitions and leaves no event behind", () => {
    const { t } = seed();
    expect(() => repo.setTaskState(t, "completed")).toThrow(IllegalTransitionError);
    expect(repo.getTaskState(t)).toBe("queued");
    expect(repo.listEvents(t)).toHaveLength(0);
    repo.setTaskState(t, "running");
    repo.setTaskState(t, "completed");
    expect(() => repo.setTaskState(t, "running")).toThrow(IllegalTransitionError);
  });
  it("does not leave an event behind when the state update fails", () => {
    expect(() => repo.setTaskState("nope", "running")).toThrow();
    expect(repo.listEvents("nope")).toHaveLength(0);
  });

  it("stores the latest agent probe per provider (upsert) and rejects unknown status", () => {
    repo.saveAgentProbe({
      provider: "claude",
      status: "ok",
      version: "2.1.316",
      capabilities: { print: true },
      probedAt: "2026-01-01T00:00:00.000Z",
    });
    repo.saveAgentProbe({
      provider: "claude",
      status: "exit_nonzero",
      capabilities: {},
      error: { step: "--version" },
      probedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(repo.getAgentProbe("claude")).toMatchObject({
      status: "exit_nonzero",
      version: undefined,
      error: { step: "--version" },
    });
    expect(repo.getAgentProbe("codex")).toBeUndefined();
    expect(() =>
      repo.saveAgentProbe({ provider: "x", status: "weird", capabilities: {}, probedAt: "t" }),
    ).toThrow();
  });
});
