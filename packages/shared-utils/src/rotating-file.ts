import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface RotatingFileOptions {
  /** Directory that holds the log files (created when missing). */
  dir: string;
  /** File stem: the live file is `<baseName>.log`. Default `agent-studio`. */
  baseName?: string;
  /** The live file is rotated before a write would push it past this many bytes. */
  maxBytes: number;
  /** At most this many rotated files are kept (the newest ones). */
  maxFiles: number;
  /** Rotated files older than this many milliseconds are deleted. */
  maxAgeMs: number;
  /** Clock; tests pass a fake one. Default `Date.now`. */
  now?: () => number;
}

export interface RotatingFileDestination {
  /** pino-compatible: one complete line (or chunk) per call. Never throws on I/O failure. */
  write(chunk: string): void;
  /** Applies the retention rules now (also done at start-up, on every rotation and hourly). */
  prune(): void;
  readonly currentPath: string;
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TS_DIGITS = 15;

/** Rotated file name: the rotation time is part of the name, so retention never depends on mtime. */
function rotatedName(base: string, ts: number, seq: number): string {
  return `${base}.${String(ts).padStart(TS_DIGITS, "0")}-${seq}.log`;
}

function parseRotated(base: string, file: string): { ts: number; seq: number } | undefined {
  if (!file.startsWith(`${base}.`) || !file.endsWith(".log")) return undefined;
  const m = /^(\d{15})-(\d+)$/.exec(file.slice(base.length + 1, -".log".length));
  return m ? { ts: Number(m[1]), seq: Number(m[2]) } : undefined;
}

/**
 * A size-rotated, time-retained log file destination (no dependencies). Pass it as the
 * `destination` of `createLogger`, wrapped in the secret-masking destination.
 *
 * Retention applies to rotated files only: the live file is never deleted, so a quiet process
 * can keep lines older than `maxAgeMs` in it until the next size rotation.
 */
export function createRotatingFileDestination(opts: RotatingFileOptions): RotatingFileDestination {
  const base = opts.baseName ?? "agent-studio";
  const now = opts.now ?? Date.now;
  const currentPath = join(opts.dir, `${base}.log`);
  mkdirSync(opts.dir, { recursive: true });
  let size = existsSync(currentPath) ? statSync(currentPath).size : 0;
  let lastPrune = now();

  function prune(): void {
    lastPrune = now();
    try {
      const rotated = readdirSync(opts.dir)
        .map((file) => ({ file, p: parseRotated(base, file) }))
        .flatMap((r) => (r.p ? [{ file: r.file, ...r.p }] : []))
        .sort((a, b) => b.ts - a.ts || b.seq - a.seq); // newest first
      rotated.forEach((r, i) => {
        if (i >= opts.maxFiles || lastPrune - r.ts > opts.maxAgeMs)
          unlinkSync(join(opts.dir, r.file));
      });
    } catch {
      // Retention is best effort: a locked file must not take the process down.
    }
  }

  function rotate(): void {
    const ts = now();
    let seq = 0;
    while (existsSync(join(opts.dir, rotatedName(base, ts, seq)))) seq++;
    renameSync(currentPath, join(opts.dir, rotatedName(base, ts, seq)));
    size = 0;
    prune();
  }

  prune();
  return {
    currentPath,
    prune,
    write(chunk: string): void {
      try {
        const bytes = Buffer.byteLength(chunk);
        if (size > 0 && size + bytes > opts.maxBytes) rotate();
        else if (now() - lastPrune >= PRUNE_INTERVAL_MS) prune();
        appendFileSync(currentPath, chunk);
        size += bytes;
      } catch {
        // A full disk or a locked file must never crash the sidecar because of logging.
      }
    },
  };
}
