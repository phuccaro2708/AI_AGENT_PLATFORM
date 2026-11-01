export const REDACTED = "[REDACTED]";

export const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|token|secret|password|passwd|authorization|cookie|credential|private[-_]?key)/i;

// Common credential shapes found inside free text.
const VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
];

function redactString(s: string): string {
  return VALUE_PATTERNS.reduce((acc, re) => acc.replace(re, REDACTED), s);
}

/** Deep-copies `value`, masking sensitive keys and credential-looking strings. */
export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactString(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]" as T;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : redact(v, seen);
  }
  return out as T;
}
