import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent } from "@agent-studio/contracts";
import { AdapterRegistry, type AgentAdapter, type AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { Orchestrator } from "./orchestrator.js";
import { Scheduler } from "./scheduler.js";

/** Records the order tasks start in and how many run at once; each run waits for `release(prompt)`. */
class Gated implements AgentAdapter {
  readonly id = "gated";
  started: string[] = [];
  seenPermissions: (string | undefined)[] = [];
  active = 0;
  maxActive = 0;
  executions = 0;
  failPrompts = new Set<string>();
  autoRelease = false;
  private gates = new Map<string, () => void>();
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  release(prompt: string) {
    const gate = this.gates.get(prompt);
    // A release with no gate would silently leave the task running and hang `idle()` until the test
    // times out; fail loudly instead.
    if (!gate) throw new Error(`release("${prompt}"): that task has not reached its gate`);
    gate();
  }
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    this.executions++;
    this.started.push(task.prompt);
    this.seenPermissions.push(task.permissions);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (!this.autoRelease) {
        await new Promise<void>((res) => this.gates.set(task.prompt, res));
      }
      if (this.failPrompts.has(task.prompt)) yield { type: "error", message: "boom" };
      else yield { type: "completed" };
    } finally {
      this.active--;
    }
  }
}

let dir: string;
let db: StudioDb;
let repo: Repo;
let wf: string;
let adapter: Gated;
let o: Orchestrator;
let nowMs: number;
const clock = () => new Date(nowMs);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-sched-"));
  db = openDatabase(join(dir, "test.db"));
  runMigrations(db);
  repo = new Repo(db);
  wf = repo.createWorkflow(repo.createProject("demo", "/p"));
  adapter = new Gated();
  const registry = new AdapterRegistry();
  registry.register(adapter);
  o = new Orchestrator(
    registry,
    repo,
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
  nowMs = Date.parse("2026-01-01T00:00:00.000Z");
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const enqueue = (prompt: string, extra: Partial<Parameters<Orchestrator["enqueue"]>[0]> = {}) =>
  o.enqueue({ workflowId: wf, agentId: "gated", prompt, ...extra });
const scheduler = (over: { concurrency?: number; leaseMs?: number } = {}) =>
  new Scheduler({ repo, orchestrator: o, clock, ...over });
/** Polls `cond` until true; a bounded, explicit wait instead of relying on event-loop tick order. */
const waitFor = async (cond: () => boolean, what: string, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((res) => setTimeout(res, 1));
  }
};
const tick = async (s: Scheduler) => {
  const before = adapter.started.length;
  const r = await s.tick();
  // Started tasks have reached their gate once the adapter has recorded them.
  await waitFor(() => adapter.started.length >= before + r.started.length, "started tasks");
  return r;
};

/** Ticks until a tick starts something (a slot freed up), bounded in time. */
const tickUntilStarted = async (s: Scheduler, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await tick(s);
    if (r.started.length > 0) return r.started;
    if (Date.now() > deadline) throw new Error("timed out waiting for a freed slot to be refilled");
    await new Promise((res) => setTimeout(res, 1));
  }
};

describe("Orchestrator.enqueue / execute", () => {
  it("persists the prompt and permissions as a task.request and creates a queued task", () => {
    const id = enqueue("hello", { permissions: "read-only", priority: 3 });
    expect(repo.getTaskState(id)).toBe("queued");
    expect(repo.getTask(id)?.priority).toBe(3);
    expect(repo.listMessages(id)[0]).toMatchObject({
      type: "task.request",
      payload: { prompt: "hello", permissions: "read-only" },
    });
  });

  it("rejects an unknown agent and a dependency cycle without leaving a task behind", () => {
    expect(() => o.enqueue({ workflowId: wf, agentId: "nope", prompt: "x" })).toThrow(
      /Unknown agent/,
    );
    const a = enqueue("a");
    expect(() => enqueue("b", { dependsOn: [a, "missing"] })).toThrow();
    expect(repo.listReadyTasks(10)).toEqual([a]);
  });

  it("execute refuses a task that is not running", async () => {
    const id = enqueue("x");
    await expect(o.execute(id)).rejects.toThrow(/not running/);
  });

  it("execute fails (does not hang) a claimed task whose agent has gone", async () => {
    const id = repo.createTask(wf, "ghost");
    repo.claimTask(id, "2099-01-01T00:00:00.000Z");
    const r = await o.execute(id);
    expect(r.finalState).toBe("failed");
    expect(repo.getTaskState(id)).toBe("failed");
  });
});

describe("Scheduler", () => {
  it("runs dependencies before dependents and passes permissions to the adapter", async () => {
    adapter.autoRelease = true;
    const c = enqueue("c", { dependsOn: [] });
    const a = enqueue("a", { permissions: "workspace-write" });
    const b = enqueue("b", { dependsOn: [a] });
    repo.addDependency(c, b);
    const s = scheduler({ concurrency: 4 });
    for (let i = 0; i < 5; i++) {
      await s.tick();
      await s.idle();
    }
    expect(adapter.started).toEqual(["a", "b", "c"]);
    expect(adapter.seenPermissions[0]).toBe("workspace-write");
    expect([a, b, c].map((t) => repo.getTaskState(t))).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("never runs more than `concurrency` tasks at once", async () => {
    // Tasks enqueued in the same millisecond tie on priority and createdAt, and the ULID tiebreak is
    // random within a millisecond, so which two start first is not fixed. Never assume "1" before "2":
    // always act on what actually started (`adapter.started`).
    for (const p of ["1", "2", "3", "4"]) enqueue(p);
    const s = scheduler({ concurrency: 2 });
    expect((await tick(s)).started).toHaveLength(2);
    expect((await tick(s)).started).toHaveLength(0); // slots are full
    expect(adapter.active).toBe(2);
    adapter.release(adapter.started[0]!);
    // The freed slot reaches the scheduler once the task settles; ticking again is harmless while full.
    expect(await tickUntilStarted(s)).toHaveLength(1);
    expect(adapter.active).toBe(2);
    expect(adapter.maxActive).toBe(2);
    for (const p of adapter.started.slice(1)) adapter.release(p);
    await s.idle();
    expect(adapter.active).toBe(0);
    expect((await tick(s)).started).toHaveLength(1); // the last task
    adapter.release(adapter.started[3]!);
    await s.idle();
    expect(adapter.executions).toBe(4);
    expect(new Set(adapter.started).size).toBe(4);
    expect(adapter.maxActive).toBe(2);
  });

  it("starts higher priority tasks first", async () => {
    enqueue("low", { priority: 1 });
    enqueue("high", { priority: 10 });
    const s = scheduler({ concurrency: 1 });
    await tick(s);
    expect(adapter.started).toEqual(["high"]);
    adapter.release("high");
    await s.idle();
  });

  it("cancels dependents of a failed task but leaves dependents of a needs_reconciliation task waiting", async () => {
    adapter.autoRelease = true;
    adapter.failPrompts.add("bad");
    const bad = enqueue("bad");
    const afterBad = enqueue("after-bad", { dependsOn: [bad] });
    const s = scheduler();
    await s.tick();
    await s.idle();
    const second = await s.tick();
    expect(second.cancelled).toEqual([afterBad]);
    expect(repo.getTaskState(afterBad)).toBe("cancelled");

    const stuck = enqueue("stuck");
    const waiter = enqueue("waiter", { dependsOn: [stuck] });
    repo.claimTask(stuck, "2099-01-01T00:00:00.000Z");
    repo.setTaskState(stuck, "needs_reconciliation");
    await s.tick();
    await s.idle();
    expect(repo.getTaskState(waiter)).toBe("queued");
    expect(adapter.started).not.toContain("waiter");
  });

  it("an expired lease means the owner died: needs_reconciliation, and the task is never re-run", async () => {
    const id = enqueue("orphan");
    repo.claimTask(id, new Date(nowMs + 60_000).toISOString()); // another process owns it
    const s = scheduler();
    expect((await s.tick()).expired).toEqual([]); // lease still valid
    nowMs += 60_001;
    expect((await s.tick()).expired).toEqual([id]);
    expect(repo.getTaskState(id)).toBe("needs_reconciliation");
    nowMs += 10 * 60_000;
    await s.tick();
    await s.idle();
    expect(adapter.executions).toBe(0);
    expect(repo.getTaskState(id)).toBe("needs_reconciliation");
  });

  it("does not expire a task this scheduler is still running, and heartbeat keeps its lease alive", async () => {
    const long = enqueue("long");
    const s = scheduler({ leaseMs: 1000 });
    await tick(s);
    nowMs += 5000; // far past the original lease
    s.heartbeat(); // what the interval timer does
    expect((await s.tick()).expired).toEqual([]);
    adapter.release("long");
    await s.idle();
    expect(repo.getTaskState(long)).toBe("completed");
    expect(adapter.executions).toBe(1);
  });

  it("two schedulers on one DB never run the same task twice", async () => {
    adapter.autoRelease = true;
    for (const p of ["1", "2", "3"]) enqueue(p);
    const a = scheduler({ concurrency: 3 });
    const b = scheduler({ concurrency: 3 });
    await Promise.all([a.tick(), b.tick()]);
    await Promise.all([a.idle(), b.idle()]);
    expect(adapter.executions).toBe(3);
  });
});
