import type { AgentLaunchSettings } from "./api";

/** One argument per line: no quoting rules to get wrong, and what you see is what is passed. */
export const parseArgs = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");

export const argsText = (args: readonly string[]): string => args.join("\n");

/** `NAME=value` per line. Returns the first problem instead of guessing. */
export function parseEnv(
  text: string,
): { ok: true; env: Record<string, string> } | { ok: false; reason: string } {
  const env: Record<string, string> = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { ok: false, reason: `Line ${i + 1}: write it as NAME=value` };
    const name = line.slice(0, eq).trim();
    if (name in env) return { ok: false, reason: `Line ${i + 1}: ${name} is set twice` };
    env[name] = line.slice(eq + 1).trim();
  }
  return { ok: true, env };
}

export const envText = (env: Readonly<Record<string, string>>): string =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

export function toSettings(
  command: string,
  args: string,
  env: string,
): { ok: true; settings: AgentLaunchSettings } | { ok: false; reason: string } {
  if (command.trim() === "") return { ok: false, reason: "Enter the command or a full path" };
  const e = parseEnv(env);
  if (!e.ok) return e;
  return { ok: true, settings: { command: command.trim(), args: parseArgs(args), env: e.env } };
}

/** Same shape the sidecar enforces; checked early only to give a quick hint, never to replace it. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const looksLikeSecretName = (n: string): boolean =>
  SECRET_NAME.test(n) && /(KEY|TOKEN|SECRET|PASSWORD)$/.test(n);
