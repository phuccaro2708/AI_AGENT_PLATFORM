import { spawn } from "node:child_process";

/**
 * What `killTree` could establish. `already_gone`: the process (group) did not exist when we looked, which is not the
 * same as `failed`: the OS refused, `taskkill` could not run, or the process was still alive afterwards. Never retried.
 */
export interface KillResult {
  status: "killed" | "already_gone" | "failed";
  /** Short reason for `failed` (exit code / errno name only: no command line, no output). */
  detail?: string;
}

/** Test seams; production uses the real `taskkill` and `process.kill(pid, 0)`. */
export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  graceMs?: number;
  runTaskkill?: (pid: number) => Promise<{ code: number | null; error?: string }>;
  isAlive?: (pid: number) => boolean;
}

const realTaskkill = (pid: number) =>
  new Promise<{ code: number | null; error?: string }>((resolve) => {
    let tk;
    try {
      tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (e) {
      resolve({ code: null, error: errName(e) });
      return;
    }
    tk.on("error", (e) => resolve({ code: null, error: errName(e) }));
    tk.on("close", (code) => resolve({ code }));
  });

const errName = (e: unknown): string =>
  (e as NodeJS.ErrnoException | undefined)?.code ?? (e instanceof Error ? e.name : "error");

/** `process.kill(pid, 0)`: ESRCH = gone; EPERM = exists but we may not touch it. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Best-effort termination of a process AND its descendants, with an honest result.
 *  - POSIX: children must have been spawned `detached` (own process group); we signal the group.
 *  - Windows: `taskkill /PID <pid> /T /F` (argument array, no shell). Exit 0 = killed; a non-zero exit is judged by
 *    looking at the pid afterwards (gone = `already_gone`, alive = `failed`); a spawn error is `failed` when the pid is alive.
 * Windows Job Objects (kill-on-close for the whole sidecar) are a separate layer owned by the Rust shell (ADR-004).
 */
export async function killTree(pid: number, opts: KillTreeOptions = {}): Promise<KillResult> {
  const platform = opts.platform ?? process.platform;
  const alive = opts.isAlive ?? pidAlive;
  if (platform === "win32") {
    const r = await (opts.runTaskkill ?? realTaskkill)(pid);
    if (r.error === undefined && r.code === 0) return { status: "killed" };
    if (!alive(pid)) return { status: "already_gone" };
    return {
      status: "failed",
      detail:
        r.error !== undefined
          ? `taskkill could not run (${r.error})`
          : `taskkill exit ${String(r.code)}`,
    };
  }
  const signalGroup = (sig: NodeJS.Signals): "sent" | "gone" | "denied" => {
    try {
      process.kill(-pid, sig);
      return "sent";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "denied";
    }
  };
  const first = signalGroup("SIGTERM");
  if (first === "gone") return { status: "already_gone" }; // group already gone
  if (first === "denied") return { status: "failed", detail: "SIGTERM was refused" };
  const groupAlive = (): boolean => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const deadline = Date.now() + (opts.graceMs ?? 500);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    if (!groupAlive()) return { status: "killed" }; // whole group exited
  }
  const second = signalGroup("SIGKILL");
  if (second === "denied") return { status: "failed", detail: "SIGKILL was refused" };
  await new Promise((r) => setTimeout(r, 50));
  return groupAlive()
    ? { status: "failed", detail: "process group still alive after SIGKILL" }
    : { status: "killed" };
}
