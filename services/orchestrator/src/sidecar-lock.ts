import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Single-instance lock for the sidecar (ADR-006 §2d). Two sidecars on one database would make the
 * second one's `recoverInterruptedTasks()` flip the first one's live tasks to `needs_reconciliation`,
 * so the lock must be held *before* `SidecarService` is constructed.
 *
 * The lock is a listen-only local server: no protocol, no data. The operating system releases the name
 * when the owner dies, so a crash never leaves a stale lock (Windows named pipes and Linux abstract
 * sockets; the file-socket fallback for other POSIX systems needs the stale check below).
 */

export class SidecarLockError extends Error {
  constructor(
    message: string,
    readonly lockName: string,
  ) {
    super(message);
    this.name = "SidecarLockError";
  }
}

export interface SidecarLock {
  release(): Promise<void>;
}

export interface AcquireOptions {
  /** How long to keep retrying while another process holds the lock. Default 3000 ms. */
  timeoutMs?: number;
  /** Pause between attempts. Default 100 ms. */
  retryMs?: number;
  /** Test seam: bind this exact name instead of the derived one. */
  nameOverride?: string;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRY_MS = 100;

/**
 * Path of the database as the operating system sees it. The parent directory is resolved (symlinks,
 * junctions, 8.3 short names, letter case on Windows) because the file itself may not exist yet; when the
 * directory does not exist either, the plain absolute path is used.
 */
function canonicalDbPath(dbPath: string): string {
  const abs = resolve(dbPath);
  let canonical = abs;
  try {
    canonical = join(realpathSync.native(dirname(abs)), basename(abs));
  } catch {
    // directory does not exist yet: keep the absolute path
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** Name of the local server that represents the lock on `dbPath`. */
export function sidecarLockName(dbPath: string): string {
  const hash = createHash("sha256").update(canonicalDbPath(dbPath)).digest("hex").slice(0, 16);
  const base = `agent-studio-sidecar-${hash}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${base}`;
  if (process.platform === "linux") return `\0${base}`; // abstract socket: no file, no stale socket
  return join(tmpdir(), `${base}.sock`);
}

/** Whether the lock is a socket file that can be left behind by a crashed owner. */
function isFileSocket(name: string): boolean {
  return process.platform !== "win32" && !name.startsWith("\0");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function listenOnce(name: string): Promise<net.Server> {
  return new Promise((resolveListen, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(name, () => {
      server.removeListener("error", reject);
      resolveListen(server);
    });
  });
}

/** True when nobody is listening on the socket file (the previous owner died without cleanup). */
function socketFileIsStale(name: string): Promise<boolean> {
  return new Promise((resolveStale) => {
    const probe = net.connect(name);
    probe.once("connect", () => {
      probe.destroy();
      resolveStale(false);
    });
    probe.once("error", (e: NodeJS.ErrnoException) => resolveStale(e.code === "ECONNREFUSED"));
  });
}

async function unlinkQuietly(name: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  await unlink(name).catch(() => undefined);
}

/**
 * Takes the lock for `dbPath`, retrying while another process holds it. In-memory databases are not
 * shared between processes, so they are never locked. Rejects with `SidecarLockError` when the holder
 * does not go away within the wait window; any other failure (e.g. access denied) is rethrown at once.
 */
export async function acquireSidecarLock(
  dbPath: string,
  opts: AcquireOptions = {},
): Promise<SidecarLock> {
  if (dbPath === "" || dbPath === ":memory:") return { release: async () => undefined };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const name = opts.nameOverride ?? sidecarLockName(dbPath);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const server = await listenOnce(name);
      // The lock must never keep the process alive on its own; the sidecar exits through `finish()`.
      server.unref();
      let released = false;
      return {
        release: () => {
          if (released) return Promise.resolve();
          released = true;
          return new Promise<void>((done) => {
            server.close(() => done());
          });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      if (isFileSocket(name) && (await socketFileIsStale(name))) {
        await unlinkQuietly(name);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SidecarLockError(
          `another sidecar already owns this database (lock ${JSON.stringify(name)}); waited ${timeoutMs} ms`,
          name,
        );
      }
      await sleep(retryMs);
    }
  }
}
