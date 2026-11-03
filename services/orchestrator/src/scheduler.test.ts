import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { Scheduler } from "./scheduler.js";

let dir: string;
let db: StudioDb;
let repo: Repo;
let wf: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-sched-"));
  db = openDatabase(join(dir, "t.db"));
  runMigrations(db);
  repo = new Repo(db);
  wf = repo.createWorkflow(repo.createProject("p", "/p"));
  clock = Date.parse("2026-01-01T00:00:00.000Z");
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});
const mk = () => new Scheduler(repo, { leaseMs: 1000, now: () => new Date(clock) });

describe("Scheduler.tick", () => {
  it("defaults to 2 concurrent tasks and fills freed slots on the next tick", () => {
    const ids = [1, 2, 3].map(() => repo.createTask(wf, "stub"));
    const s = mk();
    const t1 = s.tick();
    expect(t1.started).toHaveLength(2);
    repo.setTaskState(t1.started[0]!, "completed");
    expect(s.tick().started).toEqual([ids.find((i) => !t1.started.includes(i))]);
  });

  it("runs a diamond DAG in dependency order", () => {
    const [a, b, c, d] = [0, 1, 2, 3].map(() => repo.createTask(wf, "stub")) as [
      string,
      string,
      string,
      string,
    ];
    repo.addDependency(b, a);
    repo.addDependency(c, a);
    repo.addDependency(d, b);
    repo.addDependency(d, c);
    const s = mk();
    expect(s.tick().started).toEqual([a]);
    repo.setTaskState(a, "completed");
    expect(s.tick().started.sort()).toEqual([b, c].sort());
    repo.setTaskState(b, "completed");
    expect(s.tick().started).toEqual([]); // d still waits for c
    repo.setTaskState(c, "completed");
    expect(s.tick().started).toEqual([d]);
  });

  it("a dead worker is reconciled, not re-run, and its dependents show as blocked", () => {
    const a = repo.createTask(wf, "stub");
    const b = repo.createTask(wf, "stub");
    repo.addDependency(b, a);
    const s = mk();
    expect(s.tick().started).toEqual([a]);
    clock += 1500; // no heartbeat
    const t = s.tick();
    expect(t.expired).toEqual([a]);
    expect(t.started).toEqual([]);
    expect(t.blocked).toEqual([b]);
    expect(repo.getTaskState(a)).toBe("needs_reconciliation");
  });

  it("heartbeat keeps a long task alive", () => {
    const a = repo.createTask(wf, "stub");
    const s = mk();
    s.tick();
    clock += 800;
    expect(s.heartbeat(a)).toBe(true);
    clock += 800; // 1600 since start, but lease was renewed at 800
    expect(s.tick().expired).toEqual([]);
  });
});
