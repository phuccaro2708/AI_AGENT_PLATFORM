import { describe, expect, it } from "vitest";
import { liveChildPids, runProcess, startProcess, trackLivePid } from "./index.js";

describe("live child pids", () => {
  it("lists a tracked pid until it is released, and release is idempotent", () => {
    const untrack = trackLivePid(777001);
    expect(liveChildPids()).toContain(777001);
    untrack();
    untrack();
    expect(liveChildPids()).not.toContain(777001);
  });

  it("counts two holders of the same pid", () => {
    const a = trackLivePid(777002);
    const b = trackLivePid(777002);
    a();
    expect(liveChildPids()).toContain(777002);
    b();
    expect(liveChildPids()).not.toContain(777002);
  });

  it("ignores pids that cannot be real", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) trackLivePid(bad)();
    expect(liveChildPids().filter((p) => p <= 0 || !Number.isInteger(p))).toEqual([]);
  });

  it("startProcess lists its child while it runs and drops it when it ends", async () => {
    const running = startProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 400)"],
    });
    expect(running.pid).toBeDefined();
    expect(liveChildPids()).toContain(running.pid);
    await running.done;
    expect(liveChildPids()).not.toContain(running.pid);
  });

  it("a process that fails to start is never listed", async () => {
    const r = await runProcess({ command: "definitely-not-a-program-xyz", args: [] });
    expect(r.outcome).not.toBe("exited");
    expect(liveChildPids()).toEqual([]);
  });
});
