import type { CommandRule, NetworkRule } from "./types.js";

const WIN = process.platform === "win32";
const fold = (s: string): string => (WIN ? s.toLowerCase() : s);

/**
 * Programs that run arbitrary command text. Refused at every level, whatever the rules say: allowing one would
 * make the whole command policy meaningless. NOT exhaustive — `node`, `python`, `git -c ...` etc. can also run
 * arbitrary code, so an allow rule for such a program is a decision to trust it.
 */
const INTERPRETERS = new Set([
  "cmd",
  "powershell",
  "pwsh",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "fish",
  "wscript",
  "cscript",
  "mshta",
  "wsl",
  "env",
]);

export function baseName(executable: string): string {
  const last = executable.split(/[\\/]/).pop() ?? "";
  return last.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

export function isInterpreter(executable: string): boolean {
  return INTERPRETERS.has(baseName(executable));
}

export function validCommand(executable: unknown, args: unknown): boolean {
  return (
    typeof executable === "string" &&
    executable.trim() !== "" &&
    !executable.includes("\0") &&
    Array.isArray(args) &&
    args.every((a) => typeof a === "string" && !a.includes("\0"))
  );
}

/** Stable text for a command, used as the `command` grant target. */
export function commandKey(executable: string, args: readonly string[]): string {
  return JSON.stringify([fold(executable), ...args]);
}

function prefixMatches(rule: CommandRule, args: readonly string[]): boolean {
  const p = rule.argsPrefix ?? [];
  return p.length <= args.length && p.every((a, i) => a === args[i]);
}

/** Allow rules match the executable string exactly: `git` never matches `C:\tmp\git.exe`. */
export function matchesAllow(
  rule: CommandRule,
  executable: string,
  args: readonly string[],
): boolean {
  return fold(rule.executable) === fold(executable) && prefixMatches(rule, args);
}

/** Deny rules also match by program name, so a path-qualified copy cannot dodge them. */
export function matchesDeny(
  rule: CommandRule,
  executable: string,
  args: readonly string[],
): boolean {
  const same =
    fold(rule.executable) === fold(executable) ||
    baseName(rule.executable) === baseName(executable);
  return same && prefixMatches(rule, args);
}

export function normalizeHost(host: unknown): string | null {
  if (typeof host !== "string") return null;
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return /^[a-z0-9]([a-z0-9.:-]*[a-z0-9])?$/.test(h) ? h : null;
}

export function validPort(port: unknown): boolean {
  return (
    port === undefined ||
    (Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535)
  );
}

export function matchesNetwork(rule: NetworkRule, host: string, port: number | undefined): boolean {
  const pattern = normalizeHost(rule.host.startsWith("*.") ? rule.host.slice(2) : rule.host);
  if (pattern === null) return false;
  const hostOk = rule.host.startsWith("*.") ? host.endsWith("." + pattern) : host === pattern;
  if (!hostOk) return false;
  return rule.ports === undefined || (port !== undefined && rule.ports.includes(port));
}
