export type PressureLevel = "normal" | "reduced" | "paused";

/** Percent thresholds (0-100). `reduceAt` < `pauseAt`. */
export interface Band {
  reduceAt: number;
  pauseAt: number;
}

export interface Thresholds {
  /** System CPU busy percent over the last sampling interval. */
  cpu: Band;
  /** System memory used percent (`(total - free) / total`). */
  memory: Band;
  /** Sum of RSS of tracked child processes, bytes; reaching it reduces concurrency. Omit to ignore. */
  trackedRssReduceBytes?: number;
  /**
   * A level is left only once every metric is this many points below the threshold that caused it
   * (hysteresis against flapping). Default 5.
   */
  releaseMarginPercent: number;
}

/**
 * Starting values, NOT tuned: nobody has measured a Windows machine under real agent load
 * (docs/ASSUMPTIONS.md). Memory is the metric that matters for "does not hang the machine"
 * (ROADMAP Phase 3); CPU is deliberately lenient because a busy CLI is normal.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  cpu: { reduceAt: 85, pauseAt: 95 },
  memory: { reduceAt: 80, pauseAt: 90 },
  releaseMarginPercent: 5,
};

export function validateThresholds(t: Thresholds): void {
  const pct = (n: number) => Number.isFinite(n) && n >= 0 && n <= 100;
  for (const [name, b] of [
    ["cpu", t.cpu],
    ["memory", t.memory],
  ] as const) {
    if (!pct(b.reduceAt) || !pct(b.pauseAt) || b.reduceAt >= b.pauseAt) {
      throw new RangeError(`${name}: need 0 <= reduceAt < pauseAt <= 100`);
    }
  }
  if (!Number.isFinite(t.releaseMarginPercent) || t.releaseMarginPercent < 0) {
    throw new RangeError("releaseMarginPercent must be >= 0");
  }
  if (t.trackedRssReduceBytes !== undefined && !(t.trackedRssReduceBytes > 0)) {
    throw new RangeError("trackedRssReduceBytes must be > 0");
  }
}
