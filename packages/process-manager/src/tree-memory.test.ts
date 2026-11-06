import { describe, expect, it } from "vitest";
import { parseProcessRows, runProcess, sampleTreeBytes, treeBytes } from "./index.js";

/** P4-4 (b): RAM limit for a whole process tree (host-side watchdog; the Job Object caps are per process). */
const NODE = process.execPath;
const MB = 1024 * 1024;

describe("treeBytes / parseProcessRows", () => {
  const rows = parseProcessRows(
    "10 1 100\r\n11 10 200\n12 11 300\n99 1 5000\nnoise\n 13 10 x\n",
    1,
  );

  it("parses pid ppid value lines and ignores the rest", () => {
    expect(rows.map((r) => r.pid)).toEqual([10, 11, 12, 99]);
    expect(parseProcessRows("5 1 2", 1024)[0]?.bytes).toBe(2048);
  });

  it("sums the root and every descendant, nothing else", () => {
    expect(treeBytes(rows, 10)).toBe(600);
    expect(treeBytes(rows, 11)).toBe(500);
    expect(treeBytes(rows, 12345)).toBe(0);
  });

  it("does not loop on a cycle in bad data", () => {
    const cyc = parseProcessRows("1 2 10\n2 1 20", 1);
    expect(treeBytes(cyc, 1)).toBe(30);
  });
});

describe("sampleTreeBytes (real process table)", () => {
  it("sees this very process with a plausible size", async () => {
    expect(await sampleTreeBytes(process.pid)).toBeGreaterThan(10 * MB);
  });
});

describe("treeMemoryLimitMb", () => {
  it("kills the tree when the sampler reports more than the limit (fake sampler)", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "setTimeout(()=>{},30000)"],
      treeMemoryLimitMb: 100,
      memoryPollMs: 20,
      memorySampler: () => Promise.resolve(101 * MB),
      timeoutMs: 20_000,
    });
    expect(r.outcome).toBe("memory_limit");
    expect(r.detail).toMatch(/limit 100 MB/);
  });

  it("leaves the run alone while the sampler stays under the limit", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "setTimeout(()=>{console.log('done')},300)"],
      treeMemoryLimitMb: 100,
      memoryPollMs: 20,
      memorySampler: () => Promise.resolve(99 * MB),
    });
    expect(r.outcome).toBe("exited");
    expect(r.stdout.trim()).toBe("done");
  });

  it("fails closed when memory cannot be measured five times in a row", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "setTimeout(()=>{},30000)"],
      treeMemoryLimitMb: 100,
      memoryPollMs: 20,
      memorySampler: () => Promise.reject(new Error("boom")),
      timeoutMs: 20_000,
    });
    expect(r.outcome).toBe("memory_limit");
    expect(r.detail).toMatch(/cannot measure/);
  });

  it("rejects a limit that is not a positive integer without starting the program", async () => {
    for (const bad of [0, -5, 2.5]) {
      const r = await runProcess({ command: NODE, args: ["-e", "1"], treeMemoryLimitMb: bad });
      expect(r.outcome).toBe("spawn_error");
    }
  });

  it("with the REAL sampler, kills a parent plus grandchild whose SUM passes the limit", async () => {
    // Each of the two processes holds ~90 MB (below the 150 MB limit alone); together they pass it.
    const hold = "const b=Buffer.alloc(90*1024*1024,1);setInterval(()=>b[0]++,200);";
    const parent =
      `const {spawn}=require('node:child_process');` +
      `spawn(process.execPath,['-e',${JSON.stringify(hold)}],{stdio:'ignore'});` +
      hold;
    const r = await runProcess({
      command: NODE,
      args: ["-e", parent],
      treeMemoryLimitMb: 150,
      memoryPollMs: 300,
      timeoutMs: 40_000,
    });
    expect(r.outcome).toBe("memory_limit");
    expect(r.detail).toMatch(/MB, limit 150 MB/);
  }, 60_000);
});
