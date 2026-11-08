import * as os from "node:os";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/** Cumulative CPU time of all cores in ms (`os.cpus()` times), plus memory in bytes. */
export interface SystemReading {
  cpuBusyMs: number;
  cpuTotalMs: number;
  totalMemBytes: number;
  freeMemBytes: number;
}

/** One process at one instant: resident set in bytes and cumulative CPU time (user+system) in ms. */
export interface ProcessReading {
  rssBytes: number;
  cpuTimeMs: number;
  /**
   * When the numbers were taken (ms, same clock as the monitor's). Set by sources that measure in the
   * background, so the monitor computes CPU over the real interval between two readings and does not count
   * the same reading twice. Absent: the reading is as of the call.
   */
  atMs?: number;
}

/** Where numbers come from. Tests substitute a fake; production uses {@link NodeResourceSource}. */
export interface ResourceSource {
  system(): SystemReading;
  /** `undefined` when this platform cannot read that pid (or the pid is gone). Never a guess. */
  process(pid: number): ProcessReading | undefined;
  /**
   * Optional: asks the source to re-measure `pids` in the background (the monitor calls it, without waiting,
   * on every sample while pids are tracked). `process()` then answers from what the last refresh measured.
   * Must not reject for an ordinary failure; it may be a no-op when called again too soon.
   */
  refresh?(pids: readonly number[]): Promise<void>;
}

export interface NodeResourceSourceDeps {
  cpus?: typeof os.cpus;
  totalmem?: typeof os.totalmem;
  freemem?: typeof os.freemem;
  platform?: NodeJS.Platform;
  selfPid?: number;
  memoryUsage?: () => { rss: number };
  cpuUsage?: () => { user: number; system: number };
  /** Reads a text file; used for `/proc/<pid>/{status,stat}` on Linux only. */
  readText?: (path: string) => string;
  /** Runs a program with an argument array (no shell) and returns its stdout; used for Windows only. */
  run?: (file: string, args: string[]) => Promise<string>;
  /** Clock for the age of Windows readings. */
  nowMs?: () => number;
  /** Windows: least time between two process-table queries (each starts PowerShell). Default 2000. */
  minRefreshMs?: number;
  /** Windows: a reading older than this is not served (the process may be gone). Default 10000. */
  maxReadingAgeMs?: number;
}

/** Linux `USER_HZ`. Assumed 100 (true on every mainstream build); see docs/ASSUMPTIONS.md. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Source for the real process: `node:os` for the system, `process` for this process. Other pids: Linux reads
 * `/proc`; Windows reads a background-refreshed process table (see {@link NodeResourceSource.refresh}); macOS
 * has no reading, so `process()` returns `undefined`.
 */
export class NodeResourceSource implements ResourceSource {
  private readonly d: Required<NodeResourceSourceDeps>;

  constructor(deps: NodeResourceSourceDeps = {}) {
    this.d = {
      cpus: deps.cpus ?? os.cpus,
      totalmem: deps.totalmem ?? os.totalmem,
      freemem: deps.freemem ?? os.freemem,
      platform: deps.platform ?? process.platform,
      selfPid: deps.selfPid ?? process.pid,
      memoryUsage: deps.memoryUsage ?? (() => process.memoryUsage()),
      cpuUsage: deps.cpuUsage ?? (() => process.cpuUsage()),
      readText: deps.readText ?? ((p) => readFileSync(p, "utf8")),
      run: deps.run ?? runProgram,
      nowMs: deps.nowMs ?? Date.now,
      minRefreshMs: deps.minRefreshMs ?? 2000,
      maxReadingAgeMs: deps.maxReadingAgeMs ?? 10_000,
    };
  }

  /** Windows only: what the last process-table query measured, per tracked root pid. */
  private winCache = new Map<number, ProcessReading>();
  private winRefreshing = false;
  private winLastStartMs = Number.NEGATIVE_INFINITY;

  /**
   * Windows: Node has no API for another pid's memory or CPU time, so one `powershell.exe` query reads the
   * process table (the same `Win32_Process` query that measures a tree's RAM in process-manager) and, for each
   * pid asked, sums the working set and CPU time (kernel + user) of the pid and all its descendants: with the
   * job wrapper the root is the wrapper, not the CLI. Runs in the background, at most one at a time and at most
   * every `minRefreshMs`, because starting PowerShell costs real CPU. A pid that is gone, or whose counters
   * cannot be read, gets no reading (never 0). Other platforms: no-op.
   */
  async refresh(pids: readonly number[]): Promise<void> {
    if (this.d.platform !== "win32" || this.winRefreshing) return;
    const wanted = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    if (wanted.length === 0) {
      this.winCache.clear();
      return;
    }
    const started = this.d.nowMs();
    if (started - this.winLastStartMs < this.d.minRefreshMs) return;
    this.winRefreshing = true;
    this.winLastStartMs = started;
    try {
      const out = await this.d.run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_PROCESS_TABLE,
      ]);
      const at = this.d.nowMs();
      const rows = parseWindowsProcessTable(out);
      const next = new Map<number, ProcessReading>();
      for (const pid of wanted) {
        const sum = sumTree(rows, pid);
        if (sum) next.set(pid, { ...sum, atMs: at });
      }
      this.winCache = next;
    } catch {
      this.winCache = new Map(); // a failed query is "unknown", not "unchanged"
    } finally {
      this.winRefreshing = false;
    }
  }

  private windowsReading(pid: number): ProcessReading | undefined {
    const r = this.winCache.get(pid);
    if (!r || r.atMs === undefined) return undefined;
    return this.d.nowMs() - r.atMs > this.d.maxReadingAgeMs ? undefined : r;
  }

  system(): SystemReading {
    let busy = 0;
    let total = 0;
    for (const { times } of this.d.cpus()) {
      const all = times.user + times.nice + times.sys + times.idle + times.irq;
      total += all;
      busy += all - times.idle;
    }
    return {
      cpuBusyMs: busy,
      cpuTotalMs: total,
      totalMemBytes: this.d.totalmem(),
      freeMemBytes: this.d.freemem(),
    };
  }

  process(pid: number): ProcessReading | undefined {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    if (pid === this.d.selfPid) {
      const c = this.d.cpuUsage();
      return { rssBytes: this.d.memoryUsage().rss, cpuTimeMs: (c.user + c.system) / 1000 };
    }
    if (this.d.platform === "win32") return this.windowsReading(pid);
    if (this.d.platform !== "linux") return undefined;
    try {
      const status = this.d.readText(`/proc/${pid}/status`);
      const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      // Kernel threads / zombies have no VmRSS line; treat as unreadable, not as 0.
      if (!rss) return undefined;
      const stat = this.d.readText(`/proc/${pid}/stat`);
      // comm (field 2) may contain spaces and parens; fields after the LAST ")" are well-formed.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const utime = Number(rest[11]); // field 14
      const stime = Number(rest[12]); // field 15
      if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
      return {
        rssBytes: Number(rss[1]) * 1024,
        cpuTimeMs: ((utime + stime) * 1000) / CLOCK_TICKS_PER_SECOND,
      };
    } catch {
      return undefined; // process exited, or no permission
    }
  }
}

const WINDOWS_PROCESS_TABLE =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize) $($_.KernelModeTime) $($_.UserModeTime)" }';

interface WindowsRow {
  pid: number;
  ppid: number;
  rssBytes: number;
  /** Kernel + user time in ms (the OS counts 100 ns units). */
  cpuTimeMs: number;
}

/** Parses `pid ppid workingSet kernel100ns user100ns` lines. A line with an empty or non-numeric field is skipped. */
export function parseWindowsProcessTable(text: string): WindowsRow[] {
  const rows: WindowsRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssBytes: Number(m[3]),
      cpuTimeMs: (Number(m[4]) + Number(m[5])) / 10_000,
    });
  }
  return rows;
}

/** RSS and CPU time of `rootPid` and its descendants; `undefined` when `rootPid` is not in the table. */
export function sumTree(
  rows: readonly WindowsRow[],
  rootPid: number,
): { rssBytes: number; cpuTimeMs: number } | undefined {
  const byPid = new Map<number, WindowsRow>();
  const children = new Map<number, number[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  if (!byPid.has(rootPid)) return undefined;
  const seen = new Set<number>();
  const stack = [rootPid];
  let rssBytes = 0;
  let cpuTimeMs = 0;
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue; // pid reuse can produce a cycle in a bad snapshot
    seen.add(pid);
    const r = byPid.get(pid);
    if (r) {
      rssBytes += r.rssBytes;
      cpuTimeMs += r.cpuTimeMs;
    }
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return { rssBytes, cpuTimeMs };
}

function runProgram(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}
