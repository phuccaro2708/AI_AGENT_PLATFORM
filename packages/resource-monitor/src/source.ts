import * as os from "node:os";
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
}

/** Where numbers come from. Tests substitute a fake; production uses {@link NodeResourceSource}. */
export interface ResourceSource {
  system(): SystemReading;
  /** `undefined` when this platform cannot read that pid (or the pid is gone). Never a guess. */
  process(pid: number): ProcessReading | undefined;
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
}

/** Linux `USER_HZ`. Assumed 100 (true on every mainstream build); see docs/ASSUMPTIONS.md. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Node-only source: `node:os` for the system, `process` for this process. Other pids are readable only
 * on Linux (via `/proc`); on Windows and macOS Node has no API for that, so `process()` returns
 * `undefined` rather than shelling out to `tasklist`/`wmic`.
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
    };
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
