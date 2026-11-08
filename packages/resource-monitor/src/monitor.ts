import { concurrencyFor, decide, type Decision, type Metrics } from "./decide.js";
import type { GpuReading, ResourceSource } from "./source.js";
import { validateThresholds, type PressureLevel, type Thresholds } from "./thresholds.js";

export interface ResourceMonitorOptions {
  source: ResourceSource;
  thresholds: Thresholds;
  /** Pids whose RSS/CPU are summed into the decision and the snapshot (e.g. running CLI children). */
  trackedPids?: () => number[];
  clock?: () => number;
  /**
   * Consecutive failed samples tolerated after at least one good sample before the monitor stops trusting the
   * old level and degrades to `reduced`. Default 3. With no good sample yet, the first failure degrades.
   */
  maxStaleSamples?: number;
  /** Called when the measurement health flips (`true` = source working). For logs/UI; must not throw. */
  onHealthChange?: (
    healthy: boolean,
    detail: { error?: unknown; consecutiveFailures: number },
  ) => void;
}

export interface Snapshot extends Decision {
  metrics: Metrics;
  /** Percent CPU per tracked pid over the last interval (one core = 100). Pids that cannot be read are absent. */
  childCpuPercent: Record<number, number>;
  sampledAtMs: number;
  /** The GPU reading behind `metrics.vramPercent`; absent when there is none. */
  gpu?: GpuReading;
  /**
   * False while the source cannot be read: before the first good sample, or after more than `maxStaleSamples`
   * failures in a row. The level is then at least `reduced` and `reasons` says why.
   */
  measured: boolean;
}

/**
 * Samples a {@link ResourceSource} and keeps the latest {@link Decision}. `maxConcurrency` does no I/O,
 * so a scheduler can call it on every tick. Implements the scheduler's small admission interface.
 *
 * Failure policy (whole source): a single metric that cannot be measured never raises pressure, but a source
 * that throws is different. Until the first good sample, and after more than `maxStaleSamples` failures in a
 * row, the monitor is "unmeasured": the level is raised to at least `reduced` (half the concurrency, min 1,
 * never `paused`: a broken probe must not stop the product) and `snapshot().measured` is false. In between,
 * the previous level is kept. `lastError`, `consecutiveFailures` and `onHealthChange` expose it.
 */
export class ResourceMonitor {
  private readonly source: ResourceSource;
  private thresholds: Thresholds;
  private readonly trackedPids: () => number[];
  private readonly clock: () => number;
  private prevSystem?: { busy: number; total: number };
  private prevProc = new Map<number, { cpuTimeMs: number; atMs: number }>();
  private snap: Snapshot;
  private timer: NodeJS.Timeout | undefined;
  lastError?: unknown;
  consecutiveFailures = 0;
  private readonly maxStaleSamples: number;
  private readonly onHealthChange: ResourceMonitorOptions["onHealthChange"];
  private hadGoodSample = false;
  private healthy = true;

  constructor(opts: ResourceMonitorOptions) {
    validateThresholds(opts.thresholds);
    this.source = opts.source;
    this.thresholds = opts.thresholds;
    this.trackedPids = opts.trackedPids ?? (() => []);
    this.clock = opts.clock ?? Date.now;
    this.maxStaleSamples = opts.maxStaleSamples ?? 3;
    this.onHealthChange = opts.onHealthChange;
    this.snap = {
      level: "normal",
      reasons: [],
      metrics: {},
      childCpuPercent: {},
      sampledAtMs: this.clock(),
      measured: false,
    };
  }

  /**
   * Replaces the thresholds (validated: a bad set throws and changes nothing). When a measurement exists the
   * level is decided again at once from the last metrics (starting from the current level for hysteresis), so a
   * change in Settings takes effect without waiting for the next sample.
   */
  setThresholds(t: Thresholds): void {
    validateThresholds(t);
    this.thresholds = t;
    if (this.snap.measured) {
      this.snap = { ...this.snap, ...decide(this.snap.metrics, t, this.snap.level) };
    }
  }

  getThresholds(): Thresholds {
    return this.thresholds;
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
      const pids = this.trackedPids();
      // Background sources (Windows) measure on their own schedule: ask, do not wait; this sample reads the last answer.
      if (pids.length > 0) this.source.refresh?.(pids).catch(() => undefined);
      for (const pid of pids) {
        const p = this.source.process(pid);
        if (!p) continue;
        readable++;
        rss += p.rssBytes;
        const at = p.atMs ?? now; // when the numbers were taken, not when we asked
        const prev = this.prevProc.get(pid);
        if (prev && at === prev.atMs) {
          nextProc.set(pid, prev); // the same reading again: no new interval, keep the old baseline
          continue;
        }
        if (prev && at > prev.atMs && p.cpuTimeMs >= prev.cpuTimeMs) {
          childCpuPercent[pid] = ((p.cpuTimeMs - prev.cpuTimeMs) / (at - prev.atMs)) * 100;
        }
        nextProc.set(pid, { cpuTimeMs: p.cpuTimeMs, atMs: at });
      }
      this.prevProc = nextProc; // pids no longer tracked are forgotten
      if (readable > 0) metrics.trackedRssBytes = rss;

      // GPU is optional and must never fail the whole sample: no reading = no VRAM metric, no pressure from it.
      let gpu: GpuReading | undefined;
      try {
        this.source.refreshGpu?.().catch(() => undefined);
        gpu = this.source.gpu?.();
      } catch {
        gpu = undefined;
      }
      if (gpu && gpu.totalBytes > 0)
        metrics.vramPercent = clampPercent((gpu.usedBytes / gpu.totalBytes) * 100);

      const d = decide(metrics, this.thresholds, this.snap.level);
      this.snap = {
        ...d,
        metrics,
        childCpuPercent,
        sampledAtMs: now,
        measured: true,
        ...(gpu ? { gpu } : {}),
      };
      this.lastError = undefined;
      this.consecutiveFailures = 0;
      this.hadGoodSample = true;
      this.setHealth(true);
    } catch (err) {
      this.lastError = err;
      this.consecutiveFailures++;
      const tolerated = this.hadGoodSample && this.consecutiveFailures <= this.maxStaleSamples;
      if (!tolerated) {
        const why = `resource source unreadable (${this.consecutiveFailures} failed sample(s) in a row): no measurement`;
        const raised: PressureLevel = this.snap.level === "paused" ? "paused" : "reduced";
        if (this.snap.measured || this.snap.level !== raised) {
          this.snap = {
            ...this.snap,
            level: raised,
            reasons: this.snap.reasons
              .filter((r) => !r.startsWith("resource source unreadable"))
              .concat(why),
            measured: false,
          };
        }
        this.setHealth(false, err);
      }
    }
    return this.snap;
  }

  private setHealth(healthy: boolean, error?: unknown): void {
    if (healthy === this.healthy) return;
    this.healthy = healthy;
    try {
      this.onHealthChange?.(healthy, { error, consecutiveFailures: this.consecutiveFailures });
    } catch {
      /* a logging callback must never break sampling */
    }
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
