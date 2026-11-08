import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent } from "@agent-studio/contracts";
import { AdapterRegistry, type AgentAdapter, type AgentTask } from "@agent-studio/agent-core";
import type { ResourceSource, SystemReading } from "@agent-studio/resource-monitor";
import { trackLivePid } from "@agent-studio/process-manager";
import { createLogger } from "@agent-studio/shared-utils";
import { Repo } from "@agent-studio/storage";
import { Orchestrator } from "./orchestrator.js";
import type { Scheduler } from "./scheduler.js";
import { SidecarService } from "./sidecar.js";

/**
 * Hermetic: the resource source is a fake and the sampling timer runs on fake timers, so nothing here
 * reads the real CPU/RAM of the machine running the tests.
 */
class FakeSource implements ResourceSource {
  memoryPercent = 10;
  private busy = 0;
  private total = 0;
  /** Percent CPU the next interval should show (cumulative counters advance by 1000 ms per sample). */
  cpuPercent = 10;
  reads = 0;
  system(): SystemReading {
    this.reads++;
    this.total += 1000;
    this.busy += (1000 * this.cpuPercent) / 100;
    return {
      cpuBusyMs: this.busy,
      cpuTotalMs: this.total,
      totalMemBytes: 1000,
      freeMemBytes: 1000 - this.memoryPercent * 10,
    };
  }
  process() {
    return undefined;
  }
  refreshed: (readonly number[])[] = [];
  async refresh(pids: readonly number[]) {
    this.refreshed.push(pids);
  }
}

/** Every started task parks at its gate, so `active` is the number of tasks running at once. */
class Parked implements AgentAdapter {
  readonly id = "parked";
  active = 0;
  maxActive = 0;
  private gates: (() => void)[] = [];
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  releaseAll() {
    for (const g of this.gates.splice(0)) g();
  }
  async *execute(_task: AgentTask): AsyncIterable<AgentEvent> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise<void>((res) => this.gates.push(res));
      yield { type: "completed" };
    } finally {
      this.active--;
    }
  }
}

const CONCURRENCY = 4; // normal 4, reduced 2 (half), paused 0
const SAMPLE_MS = 1000;
const quiet = createLogger({
  name: "t",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

let dir: string;
let source: FakeSource;
let adapter: Parked;
let svc: SidecarService;
let enqueueOne: () => string;
let wfId: string;
let reqId = 0;
/** A request through the real IPC entry point, as the desktop app sends it. */
const call = async (method: string, params?: unknown) => {
  const { response } = await svc.handle({ id: ++reqId, method, ...(params ? { params } : {}) });
  return response as { result?: Record<string, any>; error?: { message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const scheduler = () => (svc as unknown as { scheduler: Scheduler }).scheduler;
/** Moves the fake clock one sampling interval: the monitor takes a new reading. */
const sample = () => vi.advanceTimersByTime(SAMPLE_MS);
const waitFor = async (cond: () => boolean, what: string) => {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((res) => setImmediate(res)); // setImmediate is not faked below
  }
};
/** One scheduler tick, then wait until every task it started has reached the adapter. */
const tick = async () => {
  const before = adapter.active;
  const r = await scheduler().tick();
  await waitFor(() => adapter.active >= before + r.started.length, "started tasks");
  return r.started.length;
};

beforeEach(() => {
  // Only the interval timers are faked: setImmediate/setTimeout stay real for the polling helpers.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  dir = mkdtempSync(join(tmpdir(), "agent-studio-admission-"));
  source = new FakeSource();
  adapter = new Parked();
  svc = new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      extraAdapters: [adapter],
      resourceSource: source,
      resourceSampleMs: SAMPLE_MS,
      schedulerConcurrency: CONCURRENCY,
    },
    quiet,
  );
  // A second Orchestrator over the same database is only used to insert queued rows.
  const repo = new Repo(svc.db);
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const feeder = new Orchestrator(registry, repo, quiet);
  mkdirSync(join(dir, "p")); // the gate refuses a project folder that does not exist
  const wf = repo.createWorkflow(repo.createProject("demo", join(dir, "p")));
  wfId = wf;
  enqueueOne = () => feeder.enqueue({ workflowId: wf, agentId: "parked", prompt: "p" });
});
afterEach(() => {
  adapter.releaseAll();
  svc.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("SidecarService resource admission", () => {
  it("starts up to `concurrency` tasks when the load is low", async () => {
    for (let i = 0; i < 6; i++) enqueueOne();
    expect(await tick()).toBe(CONCURRENCY);
    expect(await tick()).toBe(0); // full
    expect(adapter.maxActive).toBe(CONCURRENCY);
  });

  it("halves the limit under memory pressure and restores it when the load drops", async () => {
    source.memoryPercent = 85; // >= reduceAt (80), < pauseAt (90)
    sample();
    for (let i = 0; i < 6; i++) enqueueOne();
    expect(await tick()).toBe(CONCURRENCY / 2);
    expect(await tick()).toBe(0);

    // Hysteresis: 77% is still within 5 points of 80, so the limit stays halved.
    source.memoryPercent = 77;
    sample();
    expect(await tick()).toBe(0);

    source.memoryPercent = 50;
    sample();
    expect(await tick()).toBe(CONCURRENCY / 2); // 2 running + 2 more = 4
    expect(adapter.maxActive).toBe(CONCURRENCY);
  });

  it("starts nothing while paused, without touching tasks already running", async () => {
    for (let i = 0; i < 3; i++) enqueueOne();
    expect(await tick()).toBe(3);

    source.memoryPercent = 95; // >= pauseAt (90)
    sample();
    for (let i = 0; i < 3; i++) enqueueOne();
    expect(await tick()).toBe(0);
    expect(adapter.active).toBe(3); // running tasks are not aborted

    source.memoryPercent = 40;
    sample();
    expect(await tick()).toBe(1); // only one free slot left of 4
  });

  it("reduces on high CPU, using the default CPU thresholds", async () => {
    sample(); // the first CPU reading has no delta; a second one is needed
    source.cpuPercent = 90; // >= reduceAt (85), < pauseAt (95)
    sample();
    for (let i = 0; i < 4; i++) enqueueOne();
    expect(await tick()).toBe(CONCURRENCY / 2);
  });

  it("never exceeds `concurrency`, whatever the load does", async () => {
    for (let i = 0; i < 12; i++) enqueueOne();
    for (const mem of [10, 85, 95, 30, 85, 10, 99, 10]) {
      source.memoryPercent = mem;
      sample();
      await tick();
      expect(adapter.active).toBeLessThanOrEqual(CONCURRENCY);
    }
    expect(adapter.maxActive).toBeLessThanOrEqual(CONCURRENCY);
  });

  it("keeps the previous level when the source throws (a failed reading is not 'all clear')", async () => {
    source.memoryPercent = 95;
    sample();
    source.system = () => {
      throw new Error("no reading");
    };
    sample();
    enqueueOne();
    expect(await tick()).toBe(0);
  });

  describe("single tasks over IPC (workflows.start, runStub) use the same admission", () => {
    const start = () =>
      call("workflows.start", { workflowId: wfId, agentId: "parked", prompt: "p" });

    it("does not start a task while paused, and runs it after the load recovers", async () => {
      source.memoryPercent = 95; // paused
      sample();
      const r = await start();
      const taskId = r.result?.taskId as string;
      expect(taskId).toBeTruthy();
      expect(adapter.active).toBe(0);
      expect((await call("queryTask", { taskId })).result?.state).toBe("queued");
      expect(await tick()).toBe(0); // still paused

      source.memoryPercent = 40;
      sample();
      // advancing the fake clock also fired the scheduler's own interval (started by workflows.start)
      await waitFor(() => adapter.active === 1, "the held-back task to start");
      expect((await call("queryTask", { taskId })).result?.state).toBe("running");
    });

    it("can cancel a task that admission is still holding back", async () => {
      source.memoryPercent = 95;
      sample();
      const taskId = (await start()).result?.taskId as string;
      const c = await call("tasks.cancel", { taskId });
      expect(c.result).toMatchObject({ requested: true, state: "cancelled" });
      source.memoryPercent = 40;
      sample();
      expect(await tick()).toBe(0); // a cancelled task never starts
      expect(adapter.active).toBe(0);
    });

    it("never runs more than `concurrency` direct tasks at once", async () => {
      for (let i = 0; i < CONCURRENCY + 3; i++) await start();
      await waitFor(() => adapter.active >= CONCURRENCY, "tasks to reach the adapter");
      expect(adapter.active).toBe(CONCURRENCY);
      expect(adapter.maxActive).toBe(CONCURRENCY);
    });

    it("applies the reduced limit to direct tasks too", async () => {
      source.memoryPercent = 85; // reduced: half of 4
      sample();
      for (let i = 0; i < 4; i++) await start();
      await waitFor(() => adapter.active >= CONCURRENCY / 2, "tasks to reach the adapter");
      expect(adapter.active).toBe(CONCURRENCY / 2);
    });

    it("runStub does not block IPC while paused: it answers `queued`, and the task runs after recovery", async () => {
      source.memoryPercent = 95;
      sample();
      const r = await call("runStub", { prompt: "hi" }); // returns at once: IPC is served one request at a time
      expect(r.result?.finalState).toBe("queued");
      const taskId = r.result?.taskId as string;

      source.memoryPercent = 40;
      sample(); // the fake clock also fires the scheduler interval that runStub started
      await waitFor(
        () =>
          svc.db.$client.prepare("select state from tasks where id = ?").pluck().get(taskId) ===
          "completed",
        "the stub task to complete",
      );
    });

    it("runStub still answers with the final state when admission lets it run", async () => {
      const r = await call("runStub", { prompt: "hi" });
      expect(r.result?.finalState).toBe("completed");
    });
  });

  it("leaves no timer behind after close(), and starts the sampling timer only once", () => {
    // approval sweep + resource sampling; the scheduler's own timers start lazily
    const open = vi.getTimerCount();
    expect(open).toBeGreaterThanOrEqual(2);
    svc.close();
    expect(vi.getTimerCount()).toBe(0);
    const reads = source.reads;
    sample();
    expect(source.reads).toBe(reads); // sampling stopped
    svc.close(); // idempotent for the monitor
  });

  it("hands the running agents' pids to the resource source (P3-2)", () => {
    sample();
    expect(source.refreshed).toHaveLength(0); // nothing is running: nothing to measure
    const untrack = trackLivePid(424242);
    try {
      sample();
      expect(source.refreshed.at(-1)).toContain(424242);
    } finally {
      untrack();
    }
    const n = source.refreshed.length;
    sample();
    expect(source.refreshed).toHaveLength(n); // ended: no longer asked about
  });

  it("adds no sampling timer unless a resource source is given", () => {
    const base = vi.getTimerCount(); // svc: approval sweep + resource sampling
    const other = new SidecarService({ dbPath: join(dir, "other.db") }, quiet);
    try {
      expect(vi.getTimerCount()).toBe(base + 1); // only the approval sweep
    } finally {
      other.close();
    }
    expect(vi.getTimerCount()).toBe(base);
  });
});

describe("load limits saved in Settings (P3-4, P3-5)", () => {
  const T0 = {
    cpu: { reduceAt: 85, pauseAt: 95 },
    memory: { reduceAt: 80, pauseAt: 90 },
    releaseMarginPercent: 5,
  };
  const settings = (over: Record<string, unknown> = {}) => ({
    concurrency: CONCURRENCY,
    thresholds: { ...T0, ...over },
  });
  const save = (v: unknown) => call("resources.set", { settings: v });
  const startOne = () =>
    call("workflows.start", { workflowId: wfId, agentId: "parked", prompt: "p" });
  const reopen = () => {
    svc.close();
    svc = new SidecarService(
      {
        dbPath: join(dir, "s.db"),
        extraAdapters: [adapter],
        resourceSource: source,
        resourceSampleMs: SAMPLE_MS,
        schedulerConcurrency: CONCURRENCY,
      },
      quiet,
    );
  };

  it("reports the defaults, which are the monitor's own defaults, when nothing was saved", async () => {
    const r = (await call("resources.get")).result!;
    expect(r.settings).toEqual({ concurrency: CONCURRENCY, thresholds: T0 });
    expect(r.defaults).toEqual(r.settings);
    expect(r.status).toMatchObject({
      concurrency: CONCURRENCY,
      effectiveConcurrency: CONCURRENCY,
      running: 0,
    });
    expect(r.status.monitor).toMatchObject({ level: "normal", measured: true });
  });

  it("saves, applies at once, and restores the same values after a restart", async () => {
    // memory 85% is `reduced` with the defaults (reduceAt 80): with reduceAt 95 / pauseAt 99 it is `normal` (hysteresis releases 5 points below).
    source.memoryPercent = 85;
    sample();
    expect((await call("resources.get")).result!.status.monitor.level).toBe("reduced");
    const mine = settings({ memory: { reduceAt: 95, pauseAt: 99 } });
    const saved = (await save(mine)).result!;
    expect(saved.settings).toEqual(mine);
    expect(saved.status.monitor.level).toBe("normal"); // decided with the new numbers immediately

    reopen();
    const again = (await call("resources.get")).result!;
    expect(again.settings).toEqual(mine);
    expect(again.defaults.thresholds.memory).toEqual({ reduceAt: 80, pauseAt: 90 });
    sample();
    expect((await call("resources.get")).result!.status.monitor.level).toBe("normal"); // still 85%
  });

  it("refuses values out of bounds and keeps what was saved", async () => {
    const good = settings({ memory: { reduceAt: 70, pauseAt: 90 } });
    await save(good);
    for (const bad of [
      settings({ memory: { reduceAt: 90, pauseAt: 90 } }), // reduceAt must be below pauseAt
      settings({ cpu: { reduceAt: 50, pauseAt: 101 } }),
      settings({ cpu: { reduceAt: -1, pauseAt: 50 } }),
      settings({ releaseMarginPercent: 80 }),
      // margin >= reduceAt: recovery level would be negative and `paused` could never end
      settings({ cpu: { reduceAt: 10, pauseAt: 20 }, releaseMarginPercent: 30 }),
      settings({ memory: { reduceAt: 5, pauseAt: 20 }, releaseMarginPercent: 5 }),
      { ...settings(), concurrency: 0 },
      { ...settings(), concurrency: 9 },
      { ...settings(), concurrency: 1.5 },
      { ...settings(), extra: true },
      { concurrency: 2 },
    ]) {
      const r = await save(bad);
      expect(r.error?.message).toBe("invalid request");
    }
    expect((await call("resources.get")).result!.settings).toEqual(good);
    reopen();
    expect((await call("resources.get")).result!.settings).toEqual(good);
  });

  it("a single task queued while paused still runs after a restart under normal load", async () => {
    source.memoryPercent = 95;
    sample();
    const r = await call("runStub", { prompt: "hi" });
    expect(r.result?.finalState).toBe("queued");
    const taskId = r.result?.taskId as string;

    source.memoryPercent = 40; // the load is normal when the service comes back
    reopen(); // no workflow is `running`: only the queued task tells the scheduler to start
    sample();
    await waitFor(
      () =>
        svc.db.$client.prepare("select state from tasks where id = ?").pluck().get(taskId) ===
        "completed",
      "the queued task to run after the restart",
    );
  });

  it("falls back to the defaults, with a warning, when the stored value is damaged", async () => {
    new Repo(svc.db).setSetting("resources.v1", '{"concurrency": 99, "thresholds": 3}');
    reopen();
    expect((await call("resources.get")).result!.settings).toEqual({
      concurrency: CONCURRENCY,
      thresholds: T0,
    });
  });

  it("explains why tasks are held back: level, reasons and how many are queued", async () => {
    source.memoryPercent = 95;
    sample();
    await startOne();
    const s = (await call("resources.get")).result!.status;
    expect(s).toMatchObject({ effectiveConcurrency: 0, running: 0, queued: 1 });
    expect(s.monitor.level).toBe("paused");
    expect(s.monitor.reasons.join(" ")).toMatch(/memory/i);
  });

  it("applies a new thresholds set to the admission of later tasks", async () => {
    await save(settings({ memory: { reduceAt: 20, pauseAt: 30 } })); // very strict
    source.memoryPercent = 35;
    sample();
    await startOne();
    expect(adapter.active).toBe(0); // paused at 35% under the new thresholds
    source.memoryPercent = 5;
    sample();
    await waitFor(() => adapter.active === 1, "the held task to start after recovery");
  });

  it("lowering the ceiling aborts nothing and holds new tasks until enough have ended", async () => {
    for (let i = 0; i < 4; i++) await startOne();
    await waitFor(() => adapter.active === 4, "four tasks running");
    await save({ ...settings(), concurrency: 2 });
    expect(adapter.active).toBe(4); // running tasks are not touched
    await startOne();
    await startOne();
    await scheduler().tick();
    expect(adapter.active).toBe(4); // 4 running >= ceiling 2: nothing new starts
    adapter.releaseAll(); // all four finish
    await waitFor(() => adapter.active === 0, "the four tasks to end");
    await scheduler().tick();
    await waitFor(() => adapter.active === 2, "two held tasks to start under the new ceiling of 2");
    await scheduler().tick();
    expect(adapter.active).toBe(2);
    expect(adapter.maxActive).toBe(4); // the four from before; never more than the old ceiling
  });

  it("raising the ceiling lets held tasks start without waiting for the timer", async () => {
    await save({ ...settings(), concurrency: 1 });
    for (let i = 0; i < 3; i++) await startOne();
    await waitFor(() => adapter.active === 1, "one task running");
    expect(adapter.active).toBe(1);
    await save({ ...settings(), concurrency: 3 });
    await waitFor(() => adapter.active === 3, "three tasks running");
    expect(adapter.active).toBe(3);
  });

  it("never starts more than the saved ceiling while the load and the ceiling both change", async () => {
    for (let i = 0; i < 10; i++) await startOne();
    let ceiling = CONCURRENCY;
    for (const [mem, c] of [
      [10, 3],
      [85, 3],
      [95, 2],
      [30, 2],
      [85, 4],
      [10, 1],
      [99, 1],
      [10, 5],
    ] as const) {
      source.memoryPercent = mem;
      if (c !== ceiling) {
        ceiling = c;
        await save({ ...settings(), concurrency: c });
      }
      sample();
      const before = adapter.active;
      await scheduler().tick();
      await new Promise((res) => setImmediate(res));
      // A tick starts tasks only while running < min(ceiling, admission); it never aborts any.
      const limit = mem >= 90 ? 0 : mem >= 80 ? Math.max(1, Math.floor(c / 2)) : c;
      expect(adapter.active).toBeGreaterThanOrEqual(before);
      expect(adapter.active).toBeLessThanOrEqual(Math.max(before, limit));
    }
  });
});
