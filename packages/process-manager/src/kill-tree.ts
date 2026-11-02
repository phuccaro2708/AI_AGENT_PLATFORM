import { spawn } from "node:child_process";

/**
 * Best-effort termination of a process AND its descendants.
 *  - POSIX: children must have been spawned `detached` (own process group); we signal the group.
 *  - Windows: `taskkill /PID <pid> /T /F` (argument array, no shell).
 * Windows Job Objects (kill-on-close for the whole sidecar) are a separate layer owned by the Rust shell (ADR-004).
 */
export async function killTree(
  pid: number,
  opts: { platform?: NodeJS.Platform; graceMs?: number } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    await new Promise<void>((resolve) => {
      const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      tk.on("error", () => resolve());
      tk.on("close", () => resolve());
    });
    return;
  }
  const signalGroup = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) return; // group already gone
  const deadline = Date.now() + (opts.graceMs ?? 500);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    try {
      process.kill(-pid, 0);
    } catch {
      return; // whole group exited
    }
  }
  signalGroup("SIGKILL");
}
