/**
 * Upper bound for the text one stored agent event may carry. Without it one misbehaving agent can put an
 * arbitrary amount of data into the database and into every `logs.query` response.
 */
export const MAX_EVENT_CHARS = 1_048_576;

const MARKER = (dropped: number) => `\n… [${dropped} characters cut: event over the size limit]`;

/**
 * Returns `payload` with its strings shortened so that, together, they hold at most `max` characters
 * (markers included). Strings are budgeted in walk order, so the first fields keep their text. Non-string
 * values are kept as they are. An event under the limit is returned unchanged (same object).
 */
export function capEventStrings<T>(payload: T, max = MAX_EVENT_CHARS): T {
  if (totalChars(payload) <= max) return payload;
  let left = max;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length <= left) {
        left -= v.length;
        return v;
      }
      // Room for the marker is reserved with the longest count it could print (v.length), so the result
      // never exceeds what is left. A string that cannot fit its marker plus one character becomes empty.
      const keep = left - MARKER(v.length).length;
      if (keep <= 0) return "";
      const cut = v.slice(0, keep) + MARKER(v.length - keep);
      left -= cut.length;
      return cut;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(payload) as T;
}

function totalChars(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + totalChars(x), 0);
  if (v !== null && typeof v === "object") {
    return Object.values(v).reduce<number>((n, x) => n + totalChars(x), 0);
  }
  return 0;
}
