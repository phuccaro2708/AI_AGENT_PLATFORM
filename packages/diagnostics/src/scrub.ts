import { redact, REDACTED } from "@agent-studio/shared-utils";

/** Same floor as the sidecar's SecretRedactor: shorter values would shred ordinary words. */
export const MIN_SECRET_LENGTH = 6;

export interface Scrubber {
  /** Number of distinct needles in use (raw + JSON-escaped forms count once each). */
  readonly needleCount: number;
  /** Masks a block of text: exact secret values first, then credential shapes and sensitive keys. */
  text(text: string): string;
  /** Deep copy of a JSON-like value, masked the same way (keys included). */
  value<T>(value: T): T;
  /** The known secret values (raw or JSON-escaped) still present in `text`; empty when clean. */
  leaks(text: string): string[];
}

/**
 * The redaction in the sidecar masks exact values loaded at start-up, and the log lines it wrote
 * were masked then. A diagnostics bundle is built later from files and objects that may predate a
 * rotated key or come from a source that was never masked (DB dump, config), so the export runs
 * the masking again on everything it writes and then checks the result.
 */
export function createScrubber(secrets: readonly string[]): Scrubber {
  const needles = new Set<string>();
  for (const s of secrets) {
    if (s.length < MIN_SECRET_LENGTH) continue;
    needles.add(s);
    needles.add(JSON.stringify(s).slice(1, -1));
  }
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  const exact = (s: string): string => {
    let out = s;
    for (const n of ordered) if (out.includes(n)) out = out.split(n).join(REDACTED);
    return out;
  };

  const structured = (line: string): string => {
    const t = line.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.stringify(redact(JSON.parse(t) as unknown));
      } catch {
        /* not JSON: fall through to string patterns */
      }
    }
    return redact(line);
  };

  const text = (s: string): string =>
    s
      .split("\n")
      .map((line) => exact(structured(exact(line))))
      .join("\n");

  return {
    needleCount: ordered.length,
    text,
    value: <T>(v: T): T =>
      v === undefined ? v : (JSON.parse(text(JSON.stringify(redact(v)))) as T),
    leaks: (s) => ordered.filter((n) => s.includes(n)),
  };
}
