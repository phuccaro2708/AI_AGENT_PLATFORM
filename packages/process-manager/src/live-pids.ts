/**
 * Pids of the child processes this process has started and that have not ended yet. The resource monitor
 * (P3-2) reads it to measure the RAM/CPU of the running CLI agents. Only the ROOT pid of each child is listed
 * (with the job wrapper that is the wrapper, not the CLI): descendants are found by the measuring side.
 */
const live = new Map<number, number>(); // pid -> number of holders (a pid is reused by the OS only after exit)

/** Registers `pid`; call the returned function once the process ended. Safe to call it twice. */
export function trackLivePid(pid: number): () => void {
  if (!Number.isInteger(pid) || pid <= 0) return () => undefined;
  live.set(pid, (live.get(pid) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (live.get(pid) ?? 1) - 1;
    if (n <= 0) live.delete(pid);
    else live.set(pid, n);
  };
}

/** A snapshot of the pids that are running now. */
export function liveChildPids(): number[] {
  return [...live.keys()];
}
