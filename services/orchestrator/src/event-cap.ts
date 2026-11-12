/**
 * Upper bound for the text one stored agent event may carry. Without it one misbehaving agent can put an
 * arbitrary amount of data into the database and into every `logs.query` response.
 */
export const MAX_EVENT_CHARS = 1_048_576;

/**
 * Strings up to this length are identifiers or small fields (`type`, `callId`, `name`, a path). They are kept
 * whole so that a cut event still pairs with its call/result and still says what it is.
 */
const SHORT = 256;

const MARKER = (dropped: number) => `\n… [${dropped} characters cut: event over the size limit]`;

/**
 * Returns `payload` with its strings (object keys included) shortened so that, together, they hold at most
 * `max` characters (markers included). Short strings are kept whole and long ones share what is left, in walk
 * order. If the short strings alone take more than half of `max` (a payload made of many small pieces), every
 * string is budgeted in walk order instead, so the bound always holds. Non-string values are kept as they are.
 * An event under the limit is returned unchanged (same object).
 */
export function capEventStrings<T>(payload: T, max = MAX_EVENT_CHARS): T {
  if (count(payload, () => true) <= max) return payload;
  const shortTotal = count(payload, (s) => s.length <= SHORT);
  const protect = shortTotal <= max / 2;
  let left = protect ? max - shortTotal : max;
  const fit = (s: string): string => {
    if (protect && s.length <= SHORT) return s; // already paid for
    if (s.length <= left) {
      left -= s.length;
      return s;
    }
    // Room for the marker is reserved with the longest count it could print (s.length), so the result
    // never exceeds what is left. A string that cannot fit its marker plus one character becomes empty.
    const keep = left - MARKER(s.length).length;
    if (keep <= 0) return "";
    const cut = s.slice(0, keep) + MARKER(s.length - keep);
    left -= cut.length;
    return cut;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fit(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [fit(k), walk(x)]));
    }
    return v;
  };
  return walk(payload) as T;
}

/** Total length of the strings (values and object keys) that `pick` accepts. */
function count(v: unknown, pick: (s: string) => boolean): number {
  if (typeof v === "string") return pick(v) ? v.length : 0;
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + count(x, pick), 0);
  if (v !== null && typeof v === "object") {
    return Object.entries(v).reduce<number>(
      (n, [k, x]) => n + (pick(k) ? k.length : 0) + count(x, pick),
      0,
    );
  }
  return 0;
}
