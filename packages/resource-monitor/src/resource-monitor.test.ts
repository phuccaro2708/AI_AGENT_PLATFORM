import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  NodeResourceSource,
  ResourceMonitor,
  concurrencyFor,
  decide,
  validateThresholds,
  type ProcessReading,
  type ResourceSource,
  type SystemReading,
  type Thresholds,
} from "./index.js";

const T: Thresholds = {
  cpu: { reduceAt: 80, pauseAt: 95 },
  memory: { reduceAt: 70, pauseAt: 90 },
  trackedRssReduceBytes: 1000,
  releaseMarginPercent: 5,
};

describe("decide", () => {
  it("is normal below every threshold and when nothing could be measured", () => {
    expect(decide({ cpuPercent: 10, memoryPercent: 20 }, T).level).toBe("normal");
    expect(decide({}, T)).toEqual({ level: "normal", reasons: [] });
  });

  it("reduces at the reduce threshold and pauses at the pause threshold (inclusive)", () => {
    expect(decide({ cpuPercent: 80 }, T).level).toBe("reduced");
    expect(decide({ memoryPercent: 70 }, T).level).toBe("reduced");
    expect(decide({ cpuPercent: 95 }, T).level).toBe("paused");
    expect(decide({ memoryPercent: 90 }, T).level).toBe("paused");
    expect(decide({ cpuPercent: 80 }, T).reasons[0]).toMatch(/cpu .*reduce 80%/);
  });

  it("takes the worst metric", () => {
    expect(decide({ cpuPercent: 81, memoryPercent: 91 }, T).level).toBe("paused");
    expect(decide({ cpuPercent: 10, memoryPercent: 71 }, T).level).toBe("reduced");
  });

  it("reduces on tracked child RSS, and ignores it when the option is unset", () => {
    expect(decide({ trackedRssBytes: 1000 }, T).level).toBe("reduced");
    expect(decide({ trackedRssBytes: 999 }, T).level).toBe("normal");
    const noRss: Thresholds = { cpu: T.cpu, memory: T.memory, releaseMarginPercent: 5 };
    expect(decide({ trackedRssBytes: 1e12 }, noRss).level).toBe("normal");
  });

  it("applies hysteresis: leaves a level only below threshold minus the margin", () => {
    expect(decide({ memoryPercent: 68 }, T, "reduced").level).toBe("reduced"); // 70-5 < 68
    expect(decide({ memoryPercent: 65 }, T, "reduced").level).toBe("normal");
    expect(decide({ memoryPercent: 88 }, T, "paused").level).toBe("paused"); // 90-5 < 88
    expect(decide({ memoryPercent: 80 }, T, "paused").level).toBe("reduced"); // below pause band, above reduce
    expect(decide({ memoryPercent: 68 }, T, "normal").level).toBe("normal"); // no history: no stickiness
    expect(decide({ trackedRssBytes: 960 }, T, "reduced").level).toBe("reduced"); // within 5% of 1000
    expect(decide({ trackedRssBytes: 940 }, T, "reduced").level).toBe("normal");
  });
});

describe("concurrencyFor", () => {
  it("normal keeps base, reduced halves (min 1), paused is 0", () => {
    expect(concurrencyFor("normal", 4)).toBe(4);
    expect(concurrencyFor("reduced", 4)).toBe(2);
    expect(concurrencyFor("reduced", 2)).toBe(1);
    expect(concurrencyFor("reduced", 1)).toBe(1);
    expect(concurrencyFor("paused", 4)).toBe(0);
    expect(concurrencyFor("normal", 0)).toBe(0);
  });
});

describe("validateThresholds", () => {
  it("accepts the defaults and rejects nonsense", () => {
    expect(() => validateThresholds(DEFAULT_THRESHOLDS)).not.toThrow();
    expect(() => validateThresholds({ ...T, cpu: { reduceAt: 90, pauseAt: 90 } })).toThrow(
      RangeError,
    );
    expect(() => validateThresholds({ ...T, memory: { reduceAt: 50, pauseAt: 101 } })).toThrow(
      RangeError,
    );
    expect(() => validateThresholds({ ...T, cpu: { reduceAt: NaN, pauseAt: 90 } })).toThrow(
      RangeError,
    );
    expect(() => validateThresholds({ ...T, releaseMarginPercent: -1 })).toThrow(RangeError);
    expect(() => validateThresholds({ ...T, trackedRssReduceBytes: 0 })).toThrow(RangeError);
  });
});

class FakeSource implements ResourceSource {
  sys: SystemReading = { cpuBusyMs: 0, cpuTotalMs: 0, totalMemBytes: 1000, freeMemBytes: 1000 };
  procs = new Map<number, ProcessReading>();
  throwOnSystem = false;
  system() {
    if (this.throwOnSystem) throw new Error("boom");
    return this.sys;
  }
  process(pid: number) {
    return this.procs.get(pid);
  }
}

function setup(over: Partial<Thresholds> = {}) {
  const source = new FakeSource();
  let now = 0;
  let pids: number[] = [];
  const m = new ResourceMonitor({
    source,
    thresholds: { ...T, ...over },
    trackedPids: () => pids,
    clock: () => now,
  });
  return {
    source,
    m,
    advance: (ms: number) => (now += ms),
    track: (...p: number[]) => (pids = p),
  };
}

describe("ResourceMonitor", () => {
  it("starts normal (admits everything) before any sample", () => {
    const { m } = setup();
    expect(m.level).toBe("normal");
    expect(m.maxConcurrency(3)).toBe(3);
  });

  it("computes CPU percent from deltas; the first sample has no CPU figure", () => {
    const { m, source, advance } = setup();
    source.sys = { ...source.sys, cpuBusyMs: 900, cpuTotalMs: 1000 };
    expect(m.sample().metrics.cpuPercent).toBeUndefined();
    expect(m.level).toBe("normal"); // 90% lifetime average must not count
    advance(1000);
    source.sys = { ...source.sys, cpuBusyMs: 900 + 85, cpuTotalMs: 1000 + 100 };
    const s = m.sample();
    expect(s.metrics.cpuPercent).toBeCloseTo(85);
    expect(s.level).toBe("reduced");
    expect(m.maxConcurrency(4)).toBe(2);
  });

  it("computes memory percent and pauses accordingly, then recovers with hysteresis", () => {
    const { m, source } = setup();
    source.sys = { ...source.sys, freeMemBytes: 50 }; // 95% used
    expect(m.sample().level).toBe("paused");
    expect(m.maxConcurrency(4)).toBe(0);
    source.sys = { ...source.sys, freeMemBytes: 130 }; // 87% used: inside pause margin
    expect(m.sample().level).toBe("paused");
    source.sys = { ...source.sys, freeMemBytes: 250 }; // 75%: reduced
    expect(m.sample().level).toBe("reduced");
    source.sys = { ...source.sys, freeMemBytes: 400 }; // 60%
    expect(m.sample().level).toBe("normal");
    expect(m.maxConcurrency(4)).toBe(4);
  });

  it("sums RSS of readable tracked pids, derives per-child CPU, forgets untracked pids", () => {
    const { m, source, advance, track } = setup();
    track(10, 11, 12); // 12 unreadable
    source.procs.set(10, { rssBytes: 400, cpuTimeMs: 0 });
    source.procs.set(11, { rssBytes: 300, cpuTimeMs: 0 });
    let s = m.sample();
    expect(s.metrics.trackedRssBytes).toBe(700);
    expect(s.childCpuPercent).toEqual({});
    advance(1000);
    source.procs.set(10, { rssBytes: 400, cpuTimeMs: 500 });
    source.procs.set(11, { rssBytes: 700, cpuTimeMs: 1000 });
    s = m.sample();
    expect(s.metrics.trackedRssBytes).toBe(1100);
    expect(s.level).toBe("reduced"); // >= 1000
    expect(s.childCpuPercent).toEqual({ 10: 50, 11: 100 });
    track(10);
    advance(1000);
    source.procs.set(10, { rssBytes: 100, cpuTimeMs: 600 });
    s = m.sample();
    expect(s.metrics.trackedRssBytes).toBe(100);
    expect(Object.keys(s.childCpuPercent)).toEqual(["10"]);
    expect(s.level).toBe("normal");
  });

  it("leaves trackedRssBytes unmeasured when no tracked pid is readable", () => {
    const { m, track } = setup();
    track(99);
    expect(m.sample().metrics.trackedRssBytes).toBeUndefined();
  });

  it("keeps the previous level (not 'all clear') when the source throws", () => {
    const { m, source } = setup();
    source.sys = { ...source.sys, freeMemBytes: 50 };
    m.sample();
    source.throwOnSystem = true;
    expect(m.sample().level).toBe("paused");
    expect(m.lastError).toBeInstanceOf(Error);
    source.throwOnSystem = false;
    source.sys = { ...source.sys, freeMemBytes: 900 };
    m.sample();
    expect(m.lastError).toBeUndefined();
    expect(m.level).toBe("normal");
  });

  it("rejects invalid thresholds at construction", () => {
    expect(
      () =>
        new ResourceMonitor({
          source: new FakeSource(),
          thresholds: { ...T, cpu: { reduceAt: 99, pauseAt: 50 } },
        }),
    ).toThrow(RangeError);
  });

  it("start() samples immediately and stop() clears the timer", () => {
    const { m, source } = setup();
    source.sys = { ...source.sys, freeMemBytes: 50 };
    m.start(60_000);
    expect(m.level).toBe("paused");
    m.start(60_000); // idempotent
    m.stop();
    m.stop();
  });
});

describe("NodeResourceSource", () => {
  const cpus = (rows: [number, number][]) =>
    (() =>
      rows.map(([busy, idle]) => ({
        model: "x",
        speed: 0,
        times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
      }))) as unknown as typeof import("node:os").cpus;

  it("sums os.cpus() times into busy/total and reads os memory", () => {
    const src = new NodeResourceSource({
      cpus: cpus([
        [30, 70],
        [50, 50],
      ]),
      totalmem: () => 1000,
      freemem: () => 250,
    });
    expect(src.system()).toEqual({
      cpuBusyMs: 80,
      cpuTotalMs: 200,
      totalMemBytes: 1000,
      freeMemBytes: 250,
    });
  });

  it("reads this process from process.memoryUsage/cpuUsage (µs -> ms)", () => {
    const src = new NodeResourceSource({
      selfPid: 7,
      memoryUsage: () => ({ rss: 123 }),
      cpuUsage: () => ({ user: 3000, system: 1000 }),
      platform: "win32",
    });
    expect(src.process(7)).toEqual({ rssBytes: 123, cpuTimeMs: 4 });
  });

  it("reads other pids from /proc on linux (comm with spaces and parens is handled)", () => {
    const files: Record<string, string> = {
      "/proc/42/status": "Name:\tx\nVmRSS:\t   2048 kB\n",
      "/proc/42/stat": "42 (my (weird) cmd) S 1 1 1 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 1 0 0",
    };
    const src = new NodeResourceSource({
      platform: "linux",
      selfPid: 1,
      readText: (p) => {
        const v = files[p];
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
    });
    // utime 150 + stime 50 ticks at 100 Hz = 2000 ms
    expect(src.process(42)).toEqual({ rssBytes: 2048 * 1024, cpuTimeMs: 2000 });
    expect(src.process(43)).toBeUndefined(); // gone
  });

  it("returns undefined for other pids off Linux, for bad pids, and for entries without VmRSS", () => {
    const win = new NodeResourceSource({ platform: "win32", selfPid: 1, readText: () => "" });
    expect(win.process(42)).toBeUndefined();
    const lin = new NodeResourceSource({
      platform: "linux",
      selfPid: 1,
      readText: () => "Name:\tkthreadd\n",
    });
    expect(lin.process(42)).toBeUndefined();
    expect(lin.process(0)).toBeUndefined();
    expect(lin.process(-5)).toBeUndefined();
    expect(lin.process(1.5)).toBeUndefined();
  });

  it("works against the real OS: sane system numbers, own pid readable", () => {
    const src = new NodeResourceSource();
    const s = src.system();
    expect(s.totalMemBytes).toBeGreaterThan(0);
    expect(s.freeMemBytes).toBeLessThanOrEqual(s.totalMemBytes);
    expect(s.cpuTotalMs).toBeGreaterThanOrEqual(s.cpuBusyMs);
    const me = src.process(process.pid);
    expect(me?.rssBytes).toBeGreaterThan(0);
  });
});
