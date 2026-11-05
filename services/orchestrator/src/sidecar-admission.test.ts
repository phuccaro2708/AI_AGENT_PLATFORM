import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent } from "@agent-studio/contracts";
import { AdapterRegistry, type AgentAdapter, type AgentTask } from "@agent-studio/agent-core";
import type { ResourceSource, SystemReading } from "@agent-studio/resource-monitor";
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
  const wf = repo.createWorkflow(repo.createProject("demo", join(dir, "p")));
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
