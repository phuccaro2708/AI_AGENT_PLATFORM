import type { PressureLevel, Thresholds } from "./thresholds.js";

/** What was measured. A metric is `undefined` when it could not be measured; it then never raises pressure. */
export interface Metrics {
  cpuPercent?: number;
  memoryPercent?: number;
  /** Whole-GPU memory used percent (nvidia-smi). Undefined when there is no NVIDIA GPU or it could not be read. */
  vramPercent?: number;
  trackedRssBytes?: number;
}

export interface Decision {
  level: PressureLevel;
  /** Human-readable causes of a non-normal level (for logs/UI later). Empty when normal. */
  reasons: string[];
}

const RANK: Record<PressureLevel, number> = { normal: 0, reduced: 1, paused: 2 };

/**
 * Pure. Level the metrics call for if we were starting fresh, then hysteresis: from `previous`, only step
 * down when the metrics are also below `threshold - releaseMarginPercent`.
 */
export function decide(m: Metrics, t: Thresholds, previous: PressureLevel = "normal"): Decision {
  const margin = t.releaseMarginPercent;
  let level: PressureLevel = "normal";
  const reasons: string[] = [];
  const raise = (to: PressureLevel, why: string) => {
    if (RANK[to] > RANK[level]) level = to;
    reasons.push(why);
  };

  // Each metric yields its own level, with hysteresis relative to what we were at.
  const band = (
    name: string,
    value: number | undefined,
    reduceAt: number,
    pauseAt: number,
  ): void => {
    if (value === undefined) return;
    const at = (limit: number, level: PressureLevel) =>
      value >= limit || (RANK[previous] >= RANK[level] && value > limit - margin);
    const text = `${name} ${value.toFixed(1)}%`;
    if (at(pauseAt, "paused")) raise("paused", `${text} >= pause ${pauseAt}%`);
    else if (at(reduceAt, "reduced")) raise("reduced", `${text} >= reduce ${reduceAt}%`);
  };
  band("cpu", m.cpuPercent, t.cpu.reduceAt, t.cpu.pauseAt);
  band("memory", m.memoryPercent, t.memory.reduceAt, t.memory.pauseAt);
  if (t.vram) band("vram", m.vramPercent, t.vram.reduceAt, t.vram.pauseAt);

  if (t.trackedRssReduceBytes !== undefined && m.trackedRssBytes !== undefined) {
    const limit = t.trackedRssReduceBytes;
    const held = RANK[previous] >= RANK.reduced && m.trackedRssBytes > limit * (1 - margin / 100);
    if (m.trackedRssBytes >= limit || held) {
      raise("reduced", `tracked child RSS ${m.trackedRssBytes} B >= ${limit} B`);
    }
  }
  return { level, reasons };
}

/** Concurrency to allow at `level`: normal = base, reduced = half (min 1), paused = 0 (start nothing). */
export function concurrencyFor(level: PressureLevel, base: number): number {
  if (base <= 0) return 0;
  if (level === "paused") return 0;
  if (level === "reduced") return Math.max(1, Math.floor(base / 2));
  return base;
}
