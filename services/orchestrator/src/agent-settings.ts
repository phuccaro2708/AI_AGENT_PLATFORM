import { isAbsolute } from "node:path";
import {
  ExecutableNotFoundError,
  resolveExecutable,
  unwrapNpmShim,
} from "@agent-studio/process-manager";

/**
 * Validation for user-chosen agent launch settings (Phase 7B). The settings decide which program
 * the sidecar starts, so they are checked before they are probed or stored. This is a guard against
 * mistakes and against the UI quietly widening what an agent may do; it is not a sandbox.
 */
export interface AgentLaunchSettings {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type SettingsCheck =
  { ok: true; settings: AgentLaunchSettings; resolvedPath: string } | { ok: false; reason: string };

/**
 * Flags that change what the agent is allowed to do or where it works. Permissions come from the
 * task (`read-only` / `workspace-write`), the working folder from the server, so none of these may
 * be added through settings. Matched on the flag name, with or without `=value`.
 */
const FORBIDDEN_FLAGS = new Set([
  // permission / approval bypass
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--full-auto",
  "--permission-mode",
  "--permission-prompt-tool",
  "--ask-for-approval",
  "-a",
  // tool and sandbox selection
  "--tools",
  "--allowed-tools",
  "--allowedtools",
  "--disallowed-tools",
  "--disallowedtools",
  "--sandbox",
  "-s",
  // where the agent works and what configuration it loads
  "--add-dir",
  "--cd",
  "-c",
  "--config",
  "--profile",
  "-p",
  "--settings",
  "--setting-sources",
  "--mcp-config",
  "--plugin-dir",
  "--session-id",
  "--resume",
  "--continue",
  "--model-provider",
]);

/** Values that grant everything, wherever they appear in an argument. */
const FORBIDDEN_VALUES = ["danger-full-access", "bypasspermissions", "dontask"];

/**
 * Environment settings are an allowlist: only names known to be harmless are accepted. Anything
 * that changes how programs are found or loaded (PATH, NODE_OPTIONS, LD_*, DYLD_*, BASH_ENV...) or
 * that steers the CLI itself (CLAUDE_*, CODEX_*, ANTHROPIC_*, OPENAI_*) is simply not on the list.
 */
const ALLOWED_ENV = new Set([
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "LANG",
  "TZ",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]);
const allowedEnv = (name: string) => {
  const n = name.toUpperCase();
  return ALLOWED_ENV.has(n) || /^LC_[A-Z_]+$/.test(n);
};

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|BEARER)/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const MAX_ARGS = 32;
export const MAX_ARG_LENGTH = 512;
export const MAX_ENV = 32;
export const MAX_ENV_VALUE = 1024;

const hasControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32 && c !== "\t");

export function checkArgs(args: readonly string[]): string | null {
  if (args.length > MAX_ARGS) return `At most ${MAX_ARGS} extra arguments are allowed`;
  for (const raw of args) {
    if (raw.length > MAX_ARG_LENGTH) return "An extra argument is too long";
    if (hasControl(raw)) return "Extra arguments cannot contain control characters";
    const flag = raw.split("=", 1)[0]!.toLowerCase();
    // "-sfoo" / "-cfoo": a short flag with its value attached
    const short =
      /^-[a-z]/i.test(raw) && !raw.startsWith("--") ? raw.slice(0, 2).toLowerCase() : "";
    if (FORBIDDEN_FLAGS.has(flag) || (short !== "" && FORBIDDEN_FLAGS.has(short))) {
      return `The flag ${raw.split("=", 1)[0]} is not allowed here: permissions, tools and the working folder are set per task`;
    }
    const lower = raw.toLowerCase();
    if (FORBIDDEN_VALUES.some((v) => lower.includes(v))) {
      return `The argument "${raw}" would lift the agent's restrictions`;
    }
  }
  return null;
}

export function checkEnv(env: Readonly<Record<string, string>>): string | null {
  const names = Object.keys(env);
  if (names.length > MAX_ENV) return `At most ${MAX_ENV} environment variables are allowed`;
  for (const name of names) {
    if (!ENV_NAME.test(name)) return `Not a valid environment variable name: ${name}`;
    if (SECRET_NAME.test(name)) {
      return `${name} looks like a secret. Secrets are kept in the system credential store, not in settings`;
    }
    if (!allowedEnv(name)) {
      return `${name} is not an allowed environment setting (allowed: proxies, LANG, LC_*, TZ, certificate paths)`;
    }
    const value = env[name]!;
    if (value.length > MAX_ENV_VALUE) return `The value of ${name} is too long`;
    if (hasControl(value)) return `The value of ${name} contains control characters`;
  }
  return null;
}

/** The command must be a bare program name or an absolute path to a real executable file. */
export function checkCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; path: string } | { ok: false; reason: string } {
  const c = command.trim();
  if (c === "") return { ok: false, reason: "The command is empty" };
  if (hasControl(c)) return { ok: false, reason: "The command contains control characters" };
  const hasDir = c.includes("/") || c.includes("\\");
  if (hasDir && !isAbsolute(c)) {
    return { ok: false, reason: "Use a program name from PATH or an absolute path" };
  }
  try {
    const r = resolveExecutable(c, { env });
    if (r.kind === "shim" && unwrapNpmShim(r) === undefined) {
      return {
        ok: false,
        reason: `${r.path} is a .cmd/.bat shim that cannot be started safely; point to the real executable`,
      };
    }
    return { ok: true, path: r.path };
  } catch (e) {
    if (e instanceof ExecutableNotFoundError) {
      return { ok: false, reason: `No executable found for "${c}"` };
    }
    throw e;
  }
}

/** Everything that can be checked without running the program. */
export function checkAgentSettings(input: AgentLaunchSettings): SettingsCheck {
  const args = checkArgs(input.args);
  if (args !== null) return { ok: false, reason: args };
  const env = checkEnv(input.env);
  if (env !== null) return { ok: false, reason: env };
  const cmd = checkCommand(input.command);
  if (!cmd.ok) return cmd;
  return {
    ok: true,
    settings: { command: input.command.trim(), args: [...input.args], env: { ...input.env } },
    resolvedPath: cmd.path,
  };
}
