import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSidecarLock, SidecarLockError, sidecarLockName } from "./sidecar-lock.js";

// Short timings keep the contention tests fast; the production default (3 s) is covered by the
// process test that starts real sidecars.
const FAST = { timeoutMs: 300, retryMs: 20 };

let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidecar-lock-"));
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireSidecarLock", () => {
  it("lets a second holder of the same database fail with SidecarLockError after the wait window", async () => {
    const db = join(dir, "a.db");
    const first = await acquireSidecarLock(db, FAST);
    const started = Date.now();
    await expect(acquireSidecarLock(db, FAST)).rejects.toBeInstanceOf(SidecarLockError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await first.release();
  });

  it("can be acquired again once the holder released it", async () => {
    const db = join(dir, "a.db");
    await (await acquireSidecarLock(db, FAST)).release();
    const again = await acquireSidecarLock(db, FAST);
    await again.release();
  });

  it("does not make different databases wait for each other", async () => {
    const a = await acquireSidecarLock(join(dir, "a.db"), FAST);
    const b = await acquireSidecarLock(join(dir, "b.db"), FAST);
    await a.release();
    await b.release();
  });

  it("does not lock in-memory databases", async () => {
    const a = await acquireSidecarLock(":memory:", FAST);
    const b = await acquireSidecarLock(":memory:", FAST);
    await a.release();
    await b.release();
  });

  it("acquires as soon as the holder releases during the wait window", async () => {
    const db = join(dir, "a.db");
    const first = await acquireSidecarLock(db, FAST);
    setTimeout(() => void first.release(), 100);
    const second = await acquireSidecarLock(db, { timeoutMs: 2000, retryMs: 20 });
    await second.release();
  });

  it("release is idempotent", async () => {
    const lock = await acquireSidecarLock(join(dir, "a.db"), FAST);
    await lock.release();
    await lock.release();
  });

  it("is freed by the operating system when the holder is killed", async () => {
    const db = join(dir, "a.db");
    // A plain Node process holds exactly the name the sidecar would use, then is killed without cleanup.
    const holder = spawn(
      process.execPath,
      [
        "-e",
        "require('net').createServer().listen(process.argv[1], () => { console.log('held'); setInterval(() => {}, 1000); })",
        sidecarLockName(db),
      ],
      { stdio: ["ignore", "pipe", "inherit"], shell: false },
    );
    children.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout?.once("data", () => resolve());
    });
    await expect(acquireSidecarLock(db, FAST)).rejects.toBeInstanceOf(SidecarLockError);

    const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    holder.kill("SIGKILL");
    await exited;
    const lock = await acquireSidecarLock(db, { timeoutMs: 2000, retryMs: 20 });
    await lock.release();
  });

  it("rethrows errors that are not 'already held' instead of retrying", async () => {
    // A name that can never be bound (EACCES on Windows, ENOENT on POSIX): fail fast, not after the whole window.
    const nameOverride =
      process.platform === "win32" ? "not-a-pipe-name" : "/nonexistent-a3/x.sock";
    const started = Date.now();
    const err = await acquireSidecarLock(join(dir, "a.db"), {
      timeoutMs: 5000,
      retryMs: 20,
      nameOverride,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SidecarLockError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("sidecarLockName", () => {
  it("is stable for relative and absolute spellings of the same database", () => {
    const abs = join(dir, "a.db");
    const rel = relative(process.cwd(), abs);
    expect(sidecarLockName(rel)).toBe(sidecarLockName(abs));
  });

  it("differs between databases", () => {
    expect(sidecarLockName(join(dir, "a.db"))).not.toBe(sidecarLockName(join(dir, "b.db")));
  });

  it("follows a directory link to the same lock name", () => {
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(real);
    // 'junction' works without elevation on Windows and is ignored on POSIX.
    symlinkSync(real, link, "junction");
    expect(sidecarLockName(join(link, "a.db"))).toBe(sidecarLockName(join(real, "a.db")));
  });

  it.runIf(process.platform === "win32")("ignores letter case on Windows", () => {
    const abs = join(dir, "a.db");
    expect(sidecarLockName(abs.toUpperCase())).toBe(sidecarLockName(abs.toLowerCase()));
  });

  it("falls back to the plain path when the parent directory does not exist yet", () => {
    expect(() => sidecarLockName(join(dir, "missing", "a.db"))).not.toThrow();
  });

  it("uses a named pipe on Windows and an abstract socket on Linux", () => {
    const name = sidecarLockName(join(dir, "a.db"));
    if (process.platform === "win32")
      expect(name).toMatch(/^\\\\\.\\pipe\\agent-studio-sidecar-[0-9a-f]{16}$/);
    else if (process.platform === "linux")
      expect(name).toMatch(/^\0agent-studio-sidecar-[0-9a-f]{16}$/);
  });
});
