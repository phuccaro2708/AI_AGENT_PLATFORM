/**
 * Secrets arrive from the native side as environment variables named
 * `AGENT_STUDIO_SECRET__<PROVIDER>__<NAME>`. They are moved out of `process.env` at start-up so
 * nothing this process starts (git, an agent of another provider) inherits them by accident, and
 * each agent gets back only its own provider's secrets.
 */
export type Provider = "claude" | "codex";
export type ProviderSecrets = Record<Provider, Record<string, string>>;

const PREFIX = "AGENT_STUDIO_SECRET__";

export const noSecrets = (): ProviderSecrets => ({ claude: {}, codex: {} });

/** Collects the secrets from `env` and deletes them from it. */
export function takeSecretsFromEnv(env: NodeJS.ProcessEnv): ProviderSecrets {
  const out = noSecrets();
  for (const key of Object.keys(env)) {
    if (!key.startsWith(PREFIX)) continue;
    const value = env[key];
    delete env[key];
    const m = /^([A-Z]+)__([A-Z][A-Z0-9_]*)$/.exec(key.slice(PREFIX.length));
    const provider = m?.[1]?.toLowerCase();
    if (value === undefined || value === "" || !m?.[2]) continue;
    if (provider === "claude" || provider === "codex") out[provider][m[2]] = value;
  }
  return out;
}

/** Placeholder written in place of a masked secret value. */
export const SECRET_MASK = "[REDACTED]";

/**
 * Values shorter than this are never masked: replacing a 3-character "secret" would shred ordinary
 * words in every log. A secret this short is weak anyway; this is a documented limit.
 */
export const MIN_SECRET_LENGTH = 6;

export interface SecretRedactor {
  /** True when at least one loaded secret is long enough to be masked. */
  readonly active: boolean;
  /** Masks every exact occurrence of a loaded secret value in `text`. */
  text(text: string): string;
  /** Deep copy of a JSON-like value with {@link text} applied to every string (keys included). */
  deep<T>(value: T): T;
}

/**
 * Masks the exact values of the loaded secrets (all providers: no agent output may carry another
 * provider's secret either). Besides the raw value it also matches the JSON-escaped form, which is
 * how a value looks inside a serialized string. It does NOT catch transformed values (base64,
 * URL-encoding, ...) or a value split across two chunks; see docs/SECURITY.md.
 */
export function createSecretRedactor(secrets: ProviderSecrets): SecretRedactor {
  const needles = new Set<string>();
  for (const provider of Object.values(secrets)) {
    for (const value of Object.values(provider)) {
      if (value.length < MIN_SECRET_LENGTH) continue;
      needles.add(value);
      needles.add(JSON.stringify(value).slice(1, -1));
    }
  }
  // Longest first, so a secret that contains another one is masked as a whole.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  const text = (s: string): string => {
    let out = s;
    for (const needle of ordered)
      if (out.includes(needle)) out = out.split(needle).join(SECRET_MASK);
    return out;
  };
  const deep = <T>(value: T, seen = new WeakSet<object>()): T => {
    if (typeof value === "string") return text(value) as T;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]" as T;
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => deep(v, seen)) as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[text(k)] = deep(v, seen);
    return out as T;
  };
  return {
    active: ordered.length > 0,
    text,
    deep: (value) => (ordered.length === 0 ? value : deep(value)),
  };
}

/**
 * A log destination that masks secret values in every line before passing it on. pino writes one
 * complete line per call, so a value is never split across two writes here.
 */
export function redactingDestination(
  redactor: SecretRedactor,
  out: { write(chunk: string): unknown },
): { write(chunk: string): void } {
  return { write: (chunk) => void out.write(redactor.active ? redactor.text(chunk) : chunk) };
}
