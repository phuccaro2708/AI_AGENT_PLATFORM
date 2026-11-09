import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { killTree } from "./kill-tree.js";
import { startProcess } from "./process.js";

describe("killTree result (Windows branch with injected taskkill)", () => {
  const win = { platform: "win32" as const };
  it("exit 0 is killed", async () => {
    expect(await killTree(1, { ...win, runTaskkill: async () => ({ code: 0 }) })).toEqual({
      status: "killed",
    });
  });
  it("non-zero exit while the pid is gone is already_gone, not failed", async () => {
    const r = await killTree(1, {
      ...win,
      runTaskkill: async () => ({ code: 128 }),
      isAlive: () => false,
    });
    expect(r.status).toBe("already_gone");
  });
  it("non-zero exit while the pid is still alive is failed (no blind retry: taskkill ran once)", async () => {
    let calls = 0;
    const r = await killTree(1, {
      ...win,
      runTaskkill: async () => (calls++, { code: 1 }),
      isAlive: () => true,
    });
    expect(r).toEqual({ status: "failed", detail: "taskkill exit 1" });
    expect(calls).toBe(1);
  });
  it("a spawn error with a live pid is failed and names only the errno", async () => {
    const r = await killTree(1, {
      ...win,
      runTaskkill: async () => ({ code: null, error: "ENOENT" }),
      isAlive: () => true,
    });
    expect(r).toEqual({ status: "failed", detail: "taskkill could not run (ENOENT)" });
  });
  it("really kills a live process tree", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const r = await killTree(child.pid!);
    expect(r.status).toBe("killed");
  });
  it("a pid that does not exist is already_gone", async () => {
    const child = spawn(process.execPath, ["-e", "0"], {
      stdio: "ignore",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    await new Promise((r) => child.on("exit", r));
    expect((await killTree(child.pid!)).status).toBe("already_gone");
  });
});

describe("startProcess reports a refused kill", () => {
  it("cancel with a failing killTree sets killError on the result", async () => {
    const p = startProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},800)"],
      killImpl: async () => ({ status: "failed", detail: "taskkill exit 1" }),
    } as never);
    await p.cancel();
    const r = await p.done;
    expect(r.outcome).toBe("cancelled");
    expect(r.killError).toBe("taskkill exit 1");
  });
  it("a successful kill leaves killError unset", async () => {
    const p = startProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},5000)"],
    } as never);
    await p.cancel();
    const r = await p.done;
    expect(r.killError).toBeUndefined();
  });
});
