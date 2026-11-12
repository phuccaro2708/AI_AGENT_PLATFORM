/**
 * Upper bound for the text one stored agent event may carry. Without it one misbehaving agent can put an
 * arbitrary amount of data into the database and into every `logs.query` response.
 */
export const MAX_EVENT_CHARS = 1_048_576;

/**
 * Strings up to this length are identifiers or small fields (`type`, `callId`, `name`, a path). They are kept
 * whole where possible so that a cut event still pairs with its call/result and still says what it is.
 */
const SHORT = 256;

const MARKER = (dropped: number) => `\n… [${dropped} characters cut: event over the size limit]`;

/** 0: a short key or string value at the top of the event; 1: a short one further down; 2: a long one. */
type Tier = 0 | 1 | 2;
const tierOf = (s: string, depth: number): Tier => (s.length > SHORT ? 2 : depth === 0 ? 0 : 1);

/**
 * Returns `payload` with its strings (object keys included) shortened so that, together, they hold at most
 * `max` characters (markers included). Kept whole first: short keys and values at the top of the event (its
 * schema fields: `type`, `name`, `callId`…), then short strings further down; long strings share what is left,
 * in walk order. A tier is kept whole only while it fits in half of what is left, so a payload made of many
 * small pieces is still cut and the bound always holds. Non-string values are kept as they are. An event
 * under the limit is returned unchanged (same object).
 */
export function capEventStrings<T>(payload: T, max = MAX_EVENT_CHARS): T {
  const totals = [0, 0, 0];
  measure(payload, 0, totals);
  if (totals[0]! + totals[1]! + totals[2]! <= max) return payload;

  let left = max;
  const whole = [false, false];
  for (const t of [0, 1] as const) {
    if (totals[t]! <= left / 2) {
      whole[t] = true;
      left -= totals[t]!;
    }
  }
  const fit = (s: string, depth: number): string => {
    const t = tierOf(s, depth);
    if (t < 2 && whole[t]) return s; // already paid for
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
  // Same depth rule as `measure`: an object's keys and its direct string values share the object's depth.
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return fit(v, depth);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v);
      // At the top, the event's own keys and string fields (`callId`, `name`, `content`…) are budgeted before
      // anything nested, so a big nested part cannot empty them whatever their length. Key order is kept.
      const keys = entries.map(([k]) => fit(k, depth));
      const flat =
        depth === 0 ? entries.map(([, x]) => (typeof x === "string" ? fit(x, 0) : x)) : null;
      return Object.fromEntries(
        entries.map(([, x], i) => [
          keys[i],
          flat && typeof x === "string"
            ? flat[i]
            : walk(x, typeof x === "string" ? depth : depth + 1),
        ]),
      );
    }
    return v;
  };
  return walk(payload, 0) as T;
}

/** Adds the length of every string (values and object keys) to its tier's total. */
function measure(v: unknown, depth: number, totals: number[]): void {
  if (typeof v === "string") {
    totals[tierOf(v, depth)]! += v.length;
  } else if (Array.isArray(v)) {
    for (const x of v) measure(x, depth + 1, totals);
  } else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      totals[tierOf(k, depth)]! += k.length;
      measure(x, typeof x === "string" ? depth : depth + 1, totals);
    }
  }
}
