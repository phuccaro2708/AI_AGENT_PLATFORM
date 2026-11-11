import { describe, expect, it } from "vitest";
import {
  NodeResourceSource,
  ResourceMonitor,
  decide,
  parseNvidiaSmi,
  validateThresholds,
  type GpuReading,
  type ResourceSource,
  type SystemReading,
  type Thresholds,
} from "./index.js";

const MiB = 1024 * 1024;
const T: Thresholds = {
  cpu: { reduceAt: 85, pauseAt: 95 },
  memory: { reduceAt: 80, pauseAt: 90 },
  vram: { reduceAt: 80, pauseAt: 95 },
  releaseMarginPercent: 5,
};

describe("parseNvidiaSmi", () => {
  it("reads MiB pairs and returns the fullest GPU", () => {
    expect(parseNvidiaSmi("1000, 8192\r\n7000, 8192\r\n")).toEqual({
      usedBytes: 7000 * MiB,
      totalBytes: 8192 * MiB,
    });
  });

  it("is undefined for anything that is not that shape, never a guess", () => {
    expect(parseNvidiaSmi("")).toBeUndefined();
    expect(parseNvidiaSmi("N/A, N/A")).toBeUndefined();
    expect(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate")).toBeUndefined();
    expect(parseNvidiaSmi("9000, 8192")).toBeUndefined(); // used > total
    expect(parseNvidiaSmi("0, 0")).toBeUndefined();
  });
});

describe("decide with a VRAM band", () => {
  it("reduces and pauses on VRAM, with the reason named", () => {
    expect(decide({ vramPercent: 79 }, T).level).toBe("normal");
    expect(decide({ vramPercent: 80 }, T).level).toBe("reduced");
    expect(decide({ vramPercent: 95 }, T).level).toBe("paused");
    expect(decide({ vramPercent: 80 }, T).reasons[0]).toMatch(/vram .*reduce 80%/);
  });

  it("has hysteresis like the other metrics", () => {
    expect(decide({ vramPercent: 76 }, T, "reduced").level).toBe("reduced"); // 80-5 < 76
    expect(decide({ vramPercent: 74 }, T, "reduced").level).toBe("normal");
  });

  it("ignores VRAM when no band is configured, and a missing reading never raises pressure", () => {
    const off: Thresholds = { cpu: T.cpu, memory: T.memory, releaseMarginPercent: 5 };
    expect(decide({ vramPercent: 100 }, off).level).toBe("normal");
    expect(decide({}, T).level).toBe("normal");
  });
});

describe("validateThresholds with VRAM", () => {
  it("applies the same rules as the other bands", () => {
    expect(() => validateThresholds(T)).not.toThrow();
    expect(() => validateThresholds({ ...T, vram: { reduceAt: 90, pauseAt: 90 } })).toThrow(/vram/);
    expect(() => validateThresholds({ ...T, vram: { reduceAt: 4, pauseAt: 90 } })).toThrow(
      /vram: releaseMarginPercent/,
    );
  });
});

describe("NodeResourceSource GPU", () => {
  const make = (
    run: (f: string, a: string[]) => Promise<string>,
    over: { now?: () => number } = {},
  ) =>
    new NodeResourceSource({
      run,
      minGpuRefreshMs: 5000,
      ...(over.now ? { nowMs: over.now } : {}),
    });

  it("runs nvidia-smi with an argument array and serves the reading", async () => {
    const calls: [string, string[]][] = [];
    const src = make(async (f, a) => {
      calls.push([f, a]);
      return "5000, 8192\n";
    });
    expect(src.gpu()).toBeUndefined(); // nothing measured yet
    await src.refreshGpu();
    expect(calls).toEqual([
      ["nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"]],
    ]);
    expect(src.gpu()).toMatchObject({ usedBytes: 5000 * MiB, totalBytes: 8192 * MiB });
  });

  it("does not start nvidia-smi again within the minimum interval", async () => {
    let n = 0;
    let t = 0;
    const src = make(
      async () => {
        n++;
        return "1, 2";
      },
      { now: () => t },
    );
    await src.refreshGpu();
    t = 1000;
    await src.refreshGpu();
    expect(n).toBe(1);
    t = 6000;
    await src.refreshGpu();
    expect(n).toBe(2);
  });

  it("stops trying once nvidia-smi is not installed (ENOENT)", async () => {
    let n = 0;
    let t = 0;
    const src = make(
      async () => {
        n++;
        throw Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" });
      },
      { now: () => t },
    );
    await src.refreshGpu();
    t = 60_000;
    await src.refreshGpu();
    expect(n).toBe(1);
    expect(src.gpu()).toBeUndefined();
  });

  it("another failure drops the old reading and is retried later", async () => {
    let fail = false;
    let t = 0;
    const src = make(
      async () => {
        if (fail) throw new Error("timeout");
        return "1, 2";
      },
      { now: () => t },
    );
    await src.refreshGpu();
    expect(src.gpu()).toBeDefined();
    fail = true;
    t = 6000;
    await src.refreshGpu();
    expect(src.gpu()).toBeUndefined();
  });

  it("does not serve a reading older than maxReadingAgeMs", async () => {
    let t = 0;
    const src = new NodeResourceSource({
      run: async () => "1, 2",
      nowMs: () => t,
      maxReadingAgeMs: 10_000,
    });
    await src.refreshGpu();
    t = 10_001;
    expect(src.gpu()).toBeUndefined();
  });
});

describe("ResourceMonitor with a GPU", () => {
  const sys: SystemReading = {
    cpuBusyMs: 0,
    cpuTotalMs: 100,
    totalMemBytes: 100,
    freeMemBytes: 90,
  };
  const fake = (gpu: () => GpuReading | undefined): ResourceSource => ({
    system: () => sys,
    process: () => undefined,
    gpu,
  });
  const reading = (usedPct: number): GpuReading => ({
    usedBytes: usedPct * MiB,
    totalBytes: 100 * MiB,
    atMs: 0,
  });

  it("puts vramPercent in the snapshot and reduces concurrency when it crosses the band", () => {
    let pct = 50;
    const m = new ResourceMonitor({ source: fake(() => reading(pct)), thresholds: T });
    expect(m.sample().metrics.vramPercent).toBe(50);
    expect(m.snapshot().gpu?.totalBytes).toBe(100 * MiB);
    expect(m.level).toBe("normal");
    pct = 85;
    m.sample();
    expect(m.level).toBe("reduced");
    expect(m.snapshot().reasons.join()).toMatch(/vram/);
    pct = 96;
    m.sample();
    expect(m.level).toBe("paused");
    expect(m.maxConcurrency(4)).toBe(0);
  });

  it("no GPU reading: no vram metric and no pressure", () => {
    const m = new ResourceMonitor({ source: fake(() => undefined), thresholds: T });
    const s = m.sample();
    expect(s.metrics.vramPercent).toBeUndefined();
    expect(s.gpu).toBeUndefined();
    expect(s.level).toBe("normal");
    expect(s.measured).toBe(true);
  });

  it("a GPU source that throws does not make the whole sample fail", () => {
    const m = new ResourceMonitor({
      source: fake(() => {
        throw new Error("driver crashed");
      }),
      thresholds: T,
    });
    const s = m.sample();
    expect(s.measured).toBe(true);
    expect(s.level).toBe("normal");
    expect(m.consecutiveFailures).toBe(0);
  });

  it("a source without GPU support (older fakes) is unchanged", () => {
    const m = new ResourceMonitor({
      source: { system: () => sys, process: () => undefined },
      thresholds: T,
    });
    expect(m.sample().metrics.vramPercent).toBeUndefined();
  });
});
