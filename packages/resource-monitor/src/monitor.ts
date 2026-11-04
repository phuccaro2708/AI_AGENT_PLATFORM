import { concurrencyFor, decide, type Decision, type Metrics } from "./decide.js";
import type { ResourceSource } from "./source.js";
import { validateThresholds, type PressureLevel, type Thresholds } from "./thresholds.js";

export interface ResourceMonitorOptions {
  source: ResourceSource;
  thresholds: Thresholds;
  /** Pids whose RSS/CPU are summed into the decision and the snapshot (e.g. running CLI children). */
  trackedPids?: () => number[];
  clock?: () => number;
}

export interface Snapshot extends Decision {
  metrics: Metrics;
  /** Percent CPU per tracked pid over the last interval (one core = 100). Pids that cannot be read are absent. */
  childCpuPercent: Record<number, number>;
  sampledAtMs: number;
}

/**
 * Samples a {@link ResourceSource} and keeps the latest {@link Decision}. `maxConcurrency` does no I/O,
 * so a scheduler can call it on every tick. Implements the scheduler's small admission interface.
 *
 * Failure policy: if the source throws, the previous level is kept (not "all clear") and `lastError`
 * is set; a metric that cannot be measured never raises pressure.
 */
export class ResourceMonitor {
  private readonly source: ResourceSource;
  private readonly thresholds: Thresholds;
  private readonly trackedPids: () => number[];
  private readonly clock: () => number;
  private prevSystem?: { busy: number; total: number };
  private prevProc = new Map<number, { cpuTimeMs: number; atMs: number }>();
  private snap: Snapshot;
  private timer: NodeJS.Timeout | undefined;
  lastError?: unknown;

  constructor(opts: ResourceMonitorOptions) {
    validateThresholds(opts.thresholds);
    this.source = opts.source;
    this.thresholds = opts.thresholds;
    this.trackedPids = opts.trackedPids ?? (() => []);
    this.clock = opts.clock ?? Date.now;
    this.snap = {
      level: "normal",
      reasons: [],
      metrics: {},
      childCpuPercent: {},
      sampledAtMs: this.clock(),
    };
  }

  get level(): PressureLevel {
    return this.snap.level;
  }

  snapshot(): Snapshot {
    return this.snap;
  }

  /** Scheduler admission hook. */
  maxConcurrency(base: number): number {
    return concurrencyFor(this.snap.level, base);
  }

  /** Reads the source once and updates the decision. The first call has no CPU delta, so CPU is unmeasured. */
  sample(): Snapshot {
    try {
      const now = this.clock();
      const sys = this.source.system();
      const metrics: Metrics = {};

      if (this.prevSystem) {
        const total = sys.cpuTotalMs - this.prevSystem.total;
        const busy = sys.cpuBusyMs - this.prevSystem.busy;
        if (total > 0) metrics.cpuPercent = clampPercent((busy / total) * 100);
      }
      this.prevSystem = { busy: sys.cpuBusyMs, total: sys.cpuTotalMs };

      if (sys.totalMemBytes > 0) {
        metrics.memoryPercent = clampPercent(
          ((sys.totalMemBytes - sys.freeMemBytes) / sys.totalMemBytes) * 100,
        );
      }

      const childCpuPercent: Record<number, number> = {};
      const nextProc = new Map<number, { cpuTimeMs: number; atMs: number }>();
      let rss = 0;
      let readable = 0;
      for (const pid of this.trackedPids()) {
        const p = this.source.process(pid);
        if (!p) continue;
        readable++;
        rss += p.rssBytes;
        const prev = this.prevProc.get(pid);
        if (prev && now > prev.atMs && p.cpuTimeMs >= prev.cpuTimeMs) {
          childCpuPercent[pid] = ((p.cpuTimeMs - prev.cpuTimeMs) / (now - prev.atMs)) * 100;
        }
        nextProc.set(pid, { cpuTimeMs: p.cpuTimeMs, atMs: now });
      }
      this.prevProc = nextProc; // pids no longer tracked are forgotten
      if (readable > 0) metrics.trackedRssBytes = rss;

      const d = decide(metrics, this.thresholds, this.snap.level);
      this.snap = { ...d, metrics, childCpuPercent, sampledAtMs: now };
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err;
    }
    return this.snap;
  }

  /** Samples now, then every `intervalMs` (unref'd). The CPU figure needs two samples. */
  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

const clampPercent = (n: number) => Math.min(100, Math.max(0, n));
