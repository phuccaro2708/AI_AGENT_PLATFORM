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

describe("outbox / inbox (Phase 2 router storage)", () => {
  const T0 = "2026-01-01T00:00:00.000Z";
  const at0 = (taskId: string, id: string) => ({ ...msg(taskId, id), createdAt: T0 });

  it("writes message and its delivery row in one transaction", () => {
    const { t } = seed();
    repo.appendMessageWithOutbox(at0(t, "m1"), 0);
    expect(repo.listMessages(t)).toHaveLength(1);
    const due = repo.claimDueDeliveries(T0, 10);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ messageId: "m1", recipient: "orchestrator", attempts: 0 });
  });

  it("rolls back the message when the outbox insert fails (atomicity)", () => {
    const { t } = seed();
    repo.appendMessageWithOutbox(at0(t, "m1"), 0);
    // duplicate id → message insert fails → nothing else may remain
    expect(() => repo.appendMessageWithOutbox(at0(t, "m1"), 1)).toThrow();
    expect(repo.listMessages(t)).toHaveLength(1);
    expect(repo.claimDueDeliveries(T0, 10)).toHaveLength(1);
  });

  it("markDelivered removes the row from the due set", () => {
    const { t } = seed();
    repo.appendMessageWithOutbox(at0(t, "m1"), 0);
    const [d] = repo.claimDueDeliveries(T0, 10);
    repo.markDelivered(d!.id, T0);
    expect(repo.claimDueDeliveries(T0, 10)).toHaveLength(0);
  });

  it("recordDeliveryFailure reschedules, then dead-letters at maxAttempts", () => {
    const { t } = seed();
    repo.appendMessageWithOutbox(at0(t, "m1"), 0);
    const [d] = repo.claimDueDeliveries(T0, 10);
    expect(repo.recordDeliveryFailure(d!.id, "boom", "2026-01-01T00:01:00.000Z", 2)).toBe(
      "pending",
    );
    expect(repo.claimDueDeliveries(T0, 10)).toHaveLength(0); // not due yet
    expect(repo.claimDueDeliveries("2026-01-01T00:01:00.000Z", 10)).toHaveLength(1);
    expect(repo.recordDeliveryFailure(d!.id, "boom2", "2026-01-01T00:02:00.000Z", 2)).toBe("dead");
    expect(repo.claimDueDeliveries("2030-01-01T00:00:00.000Z", 10)).toHaveLength(0);
    expect(repo.listDeadLetters()).toMatchObject([
      { messageId: "m1", attempts: 2, lastError: "boom2" },
    ]);
  });

  it("acceptInbound dedupes per (recipient, message)", () => {
    const { t } = seed();
    repo.appendMessageWithOutbox(at0(t, "m1"), 0);
    expect(repo.acceptInbound("orchestrator", "m1", T0)).toBe(true);
    expect(repo.acceptInbound("orchestrator", "m1", T0)).toBe(false);
    expect(repo.acceptInbound("claude", "m1", T0)).toBe(true);
  });

  it("deliveries survive a reopen of the database (no lost committed message)", () => {
    const { t } = seed();
    repo.appendMessageWithOutbox(at0(t, "m1"), 0);
    db.$client.close();
    db = openDatabase(join(dir, "test.db"));
    runMigrations(db);
    repo = new Repo(db);
    expect(repo.claimDueDeliveries(T0, 10)).toHaveLength(1);
  });
});

describe("task DAG & leases (Phase 2 scheduler storage)", () => {
  const T0 = "2026-01-01T00:00:00.000Z";
  const plus = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
  let seq = 0;
  const wfWith = (n: number, priorities: number[] = []) => {
    const w = repo.createWorkflow(repo.createProject("p", `/p${seq++}`));
    const ids = Array.from({ length: n }, (_, i) =>
      repo.createTask(w, "stub", { priority: priorities[i] ?? 0 }),
    );
    return { w, ids };
  };

  it("rejects self, cross-workflow and cyclic dependencies", () => {
    const { ids } = wfWith(3);
    const [a, b, c] = ids as [string, string, string];
    repo.addDependency(b, a); // b depends on a
    repo.addDependency(c, b);
    expect(() => repo.addDependency(a, c)).toThrow(/cycle/i); // a→c→b→a
    expect(() => repo.addDependency(a, a)).toThrow();
    const other = wfWith(1).ids[0]!;
    expect(() => repo.addDependency(a, other)).toThrow(/workflow/i);
    repo.addDependency(b, a); // idempotent
  });

  it("claims only tasks whose dependencies are completed, highest priority first", () => {
    const { ids } = wfWith(3, [0, 5, 9]);
    const [a, b, c] = ids as [string, string, string];
    repo.addDependency(c, a); // c (prio 9) waits for a
    expect(repo.claimNextReady({ now: T0, leaseMs: 1000, maxConcurrent: 5 })).toBe(b);
    expect(repo.claimNextReady({ now: T0, leaseMs: 1000, maxConcurrent: 5 })).toBe(a);
    expect(repo.claimNextReady({ now: T0, leaseMs: 1000, maxConcurrent: 5 })).toBeUndefined(); // c blocked
    repo.setTaskState(a, "completed");
    expect(repo.claimNextReady({ now: T0, leaseMs: 1000, maxConcurrent: 5 })).toBe(c);
  });

  it("respects maxConcurrent and frees a slot when a task finishes", () => {
    const { ids } = wfWith(3);
    const claim = () => repo.claimNextReady({ now: T0, leaseMs: 1000, maxConcurrent: 2 });
    const first = claim();
    expect(first).toBeDefined();
    expect(claim()).toBeDefined();
    expect(claim()).toBeUndefined();
    repo.setTaskState(first!, "completed");
    expect(claim()).toBeDefined();
    expect(ids).toHaveLength(3);
  });

  it("listBlockedTasks reports queued tasks behind a failed dependency", () => {
    const { ids } = wfWith(2);
    const [a, b] = ids as [string, string];
    repo.addDependency(b, a);
    expect(repo.claimNextReady({ now: T0, leaseMs: 1000, maxConcurrent: 5 })).toBe(a);
    repo.setTaskState(a, "failed");
    expect(repo.listBlockedTasks()).toEqual([b]);
    expect(repo.claimNextReady({ now: T0, leaseMs: 1000, maxConcurrent: 5 })).toBeUndefined();
  });

  it("heartbeat extends a lease; an expired lease becomes needs_reconciliation, never re-queued", () => {
    const { ids } = wfWith(2);
    const a = repo.claimNextReady({ now: T0, leaseMs: 1000, maxConcurrent: 5 })!;
    expect(repo.heartbeat(a, plus(500), 1000)).toBe(true); // lease → +1500
    expect(repo.expireLeases(plus(1200))).toEqual([]);
    expect(repo.expireLeases(plus(1600))).toEqual([a]);
    expect(repo.getTaskState(a)).toBe("needs_reconciliation");
    expect(repo.heartbeat(a, plus(1700), 1000)).toBe(false);
    expect(ids).toContain(a);
  });

  it("clears the lease when a task leaves running", () => {
    wfWith(1);
    const a = repo.claimNextReady({ now: T0, leaseMs: 1000, maxConcurrent: 5 })!;
    repo.setTaskState(a, "completed");
    expect(repo.expireLeases(plus(99_999))).toEqual([]);
  });
});
