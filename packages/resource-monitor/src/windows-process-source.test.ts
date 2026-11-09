import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  NodeResourceSource,
  ResourceMonitor,
  parseWindowsProcessTable,
  sumTree,
  type ProcessReading,
  type ResourceSource,
  type SystemReading,
} from "./index.js";

const MB = 1024 * 1024;
const T = {
  cpu: { reduceAt: 85, pauseAt: 95 },
  memory: { reduceAt: 80, pauseAt: 90 },
  releaseMarginPercent: 5,
};

/** `pid ppid workingSet kernel100ns user100ns`; 10_000 units of 100 ns = 1 ms. */
const table = (...rows: [number, number, number, number, number][]) =>
  rows.map((r) => r.join(" ")).join("\r\n") + "\r\n";

describe("Windows process table", () => {
  it("parses well-formed lines and skips a line whose counters are empty", () => {
    const rows = parseWindowsProcessTable(
      table([10, 1, 5 * MB, 10_000, 20_000]) + "11 10   \r\n12 10 abc 1 2\r\n",
    );
    expect(rows).toEqual([{ pid: 10, ppid: 1, rssBytes: 5 * MB, cpuTimeMs: 3 }]);
  });

  it("sums the working set and CPU time of the pid and all descendants, and ignores the rest", () => {
    const rows = parseWindowsProcessTable(
      table(
        [10, 1, 10, 10_000, 0], // wrapper
        [11, 10, 20, 0, 20_000], // the CLI
        [12, 11, 30, 30_000, 0], // its child
        [99, 1, 1000, 1_000_000, 0], // unrelated
      ),
    );
    expect(sumTree(rows, 10)).toEqual({ rssBytes: 60, cpuTimeMs: 6 });
    expect(sumTree(rows, 11)).toEqual({ rssBytes: 50, cpuTimeMs: 5 });
  });

  it("returns undefined, not 0, for a pid that is not in the table; a pid cycle cannot loop", () => {
    expect(sumTree(parseWindowsProcessTable(table([10, 1, 5, 0, 0])), 77)).toBeUndefined();
    const cyc = parseWindowsProcessTable(table([10, 11, 5, 0, 0], [11, 10, 5, 0, 0]));
    expect(sumTree(cyc, 10)).toEqual({ rssBytes: 10, cpuTimeMs: 0 });
  });
});

describe("NodeResourceSource on Windows (injected PowerShell)", () => {
  function make(over: { out?: () => Promise<string> } = {}) {
    let now = 1_000_000;
    const calls: { file: string; args: string[] }[] = [];
    let out = table([10, 1, 5 * MB, 10_000, 10_000]);
    const src = new NodeResourceSource({
      platform: "win32",
      selfPid: 1,
      nowMs: () => now,
      run: async (file, args) => {
        calls.push({ file, args });
        return over.out ? over.out() : out;
      },
    });
    return {
      src,
      calls,
      advance: (ms: number) => (now += ms),
      setOut: (t: string) => (out = t),
    };
  }

  it("has no reading before the first refresh, then reads the process table with an argument array", async () => {
    const { src, calls } = make();
    expect(src.process(10)).toBeUndefined();
    await src.refresh([10]);
    expect(src.process(10)).toMatchObject({ rssBytes: 5 * MB, cpuTimeMs: 2, atMs: 1_000_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("powershell.exe");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(calls[0]!.args.join(" ")).not.toMatch(/\b10\b/); // pids are never interpolated into the script
  });

  it("does not start PowerShell again within minRefreshMs, nor twice at once", async () => {
    const { src, calls, advance } = make();
    await Promise.all([src.refresh([10]), src.refresh([10])]);
    expect(calls).toHaveLength(1);
    advance(500);
    await src.refresh([10]);
    expect(calls).toHaveLength(1);
    advance(2000);
    await src.refresh([10]);
    expect(calls).toHaveLength(2);
  });

  it("a pid that exited is no longer served after the next refresh", async () => {
    const { src, setOut, advance } = make();
    await src.refresh([10]);
    expect(src.process(10)).toBeDefined();
    setOut(table([99, 1, 5, 0, 0]));
    advance(3000);
    await src.refresh([10]);
    expect(src.process(10)).toBeUndefined();
  });

  it("does not serve an old reading (the process may be gone since)", async () => {
    const { src, advance } = make();
    await src.refresh([10]);
    advance(11_000);
    expect(src.process(10)).toBeUndefined();
  });

  it("a failed query clears the readings instead of keeping them, and does not reject", async () => {
    let fail = false;
    const { src, advance } = make({
      out: async () => {
        if (fail) throw new Error("powershell missing");
        return table([10, 1, 5 * MB, 0, 0]);
      },
    });
    await src.refresh([10]);
    expect(src.process(10)).toBeDefined();
    fail = true;
    advance(3000);
    await expect(src.refresh([10])).resolves.toBeUndefined();
    expect(src.process(10)).toBeUndefined();
  });

  it("is a no-op for other platforms and for invalid pids", async () => {
    const calls: unknown[] = [];
    const lin = new NodeResourceSource({
      platform: "linux",
      run: async () => (calls.push(1), ""),
    });
    await lin.refresh([10]);
    const { src } = make();
    await src.refresh([0, -3, 1.5]);
    expect(calls).toHaveLength(0);
    expect(src.process(-3)).toBeUndefined();
  });
});

describe("ResourceMonitor with a source that measures in the background", () => {
  class Bg implements ResourceSource {
    reading: ProcessReading | undefined;
    refreshed: (readonly number[])[] = [];
    system(): SystemReading {
      return { cpuBusyMs: 0, cpuTotalMs: 0, totalMemBytes: 1000, freeMemBytes: 1000 };
    }
    process() {
      return this.reading;
    }
    async refresh(pids: readonly number[]) {
      this.refreshed.push(pids);
    }
  }

  it("uses the time of the reading, and does not count the same reading twice", () => {
    const source = new Bg();
    let now = 0;
    const m = new ResourceMonitor({
      source,
      thresholds: T,
      trackedPids: () => [10],
      clock: () => now,
    });
    source.reading = { rssBytes: 100, cpuTimeMs: 0, atMs: 0 };
    m.sample();
    now = 1000; // the sample ran, but no newer reading has arrived: still the one from t=0
    expect(m.sample().childCpuPercent).toEqual({});
    now = 2000;
    source.reading = { rssBytes: 100, cpuTimeMs: 1000, atMs: 1800 }; // 1000 ms of CPU in the 1800 ms since t=0
    const s = m.sample();
    expect(s.childCpuPercent[10]).toBeCloseTo((1000 / 1800) * 100, 5);
    now = 3000;
    expect(m.sample().childCpuPercent).toEqual({}); // same reading again: no spike, no zero
    expect(source.refreshed.length).toBe(4); // asked every sample, not awaited
  });

  it("asks nothing when no pid is tracked", () => {
    const source = new Bg();
    new ResourceMonitor({ source, thresholds: T, trackedPids: () => [] }).sample();
    expect(source.refreshed).toHaveLength(0);
  });

  it("a rejecting refresh does not break sampling", () => {
    const source = new Bg();
    source.refresh = () => Promise.reject(new Error("x"));
    const m = new ResourceMonitor({ source, thresholds: T, trackedPids: () => [10] });
    expect(m.sample().measured).toBe(true);
  });
});

describe.skipIf(process.platform !== "win32")("real process on this Windows machine", () => {
  it("RSS and CPU time of a real child match what the child reports about itself", async () => {
    // The child allocates ~200 MB (touched, so it is resident), reports its own numbers on stdout, then burns CPU.
    const script = `
      const big = Buffer.alloc(200 * 1024 * 1024, 1);
      let sum = 0; for (let i = 0; i < big.length; i += 4096) sum += big[i];
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); // idle first: the outside baseline is taken here
      const u0 = process.cpuUsage();
      const stop = Date.now() + 2500;
      while (Date.now() < stop) { sum++; }
      const u = process.cpuUsage(u0);
      process.stdout.write(JSON.stringify({ rss: process.memoryUsage().rss, cpuMs: (u.user + u.system) / 1000, sum }) + "\\n");
      setTimeout(() => {}, 3000);
    `;
    const child = spawn(process.execPath, ["-e", script], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const pid = child.pid!;
      let reported = "";
      child.stdout.on("data", (b: Buffer) => (reported += b.toString()));
      const src = new NodeResourceSource({ minRefreshMs: 0 });
      const readings: ProcessReading[] = [];
      const deadline = Date.now() + 20_000;
      while (!reported.includes("\n") && Date.now() < deadline) {
        await src.refresh([pid]);
        const r = src.process(pid);
        if (r) readings.push(r);
      }
      // A reading takes a second or more on a busy runner, so only the idle baseline is required here.
      expect(readings.length).toBeGreaterThanOrEqual(1);
      const mine = JSON.parse(reported.trim()) as { rss: number; cpuMs: number };
      // After the burn, one more reading while the child is idle but alive.
      await src.refresh([pid]);
      const last = src.process(pid)!;
      expect(last).toBeDefined();
      // Resident memory: the child's own figure vs the working set seen from outside (within 25%).
      expect(Math.abs(last.rssBytes - mine.rss) / mine.rss).toBeLessThan(0.25);
      expect(last.rssBytes).toBeGreaterThan(150 * MB);
      // CPU: the child burned ~2500 ms; the outside reading grew by about that (startup adds a little).
      const grown = last.cpuTimeMs - readings[0]!.cpuTimeMs;
      expect(grown).toBeGreaterThan(1500);
      expect(grown).toBeLessThan(4500);
      console.log(
        `real-process check: child rss=${(mine.rss / MB).toFixed(1)} MB, outside rss=${(last.rssBytes / MB).toFixed(1)} MB; ` +
          `child cpu=${mine.cpuMs.toFixed(0)} ms, outside cpu delta=${grown.toFixed(0)} ms, readings=${readings.length}`,
      );
    } finally {
      child.kill();
    }
  }, 60_000);

  it("a pid that has exited gets no reading", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { shell: false, windowsHide: true });
    const pid = child.pid!;
    await new Promise((res) => child.once("exit", res));
    const src = new NodeResourceSource({ minRefreshMs: 0 });
    await src.refresh([pid]);
    expect(src.process(pid)).toBeUndefined();
  }, 30_000);
});
