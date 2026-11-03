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
