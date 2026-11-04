import { hasFlag, hasSubcommand } from "./probe.js";

/**
 * A capability is "seen in help text", nothing more. `help` names which help text to look in
 * (`main` unless a candidate defines more in `helpCommands`).
 */
export type CapabilityRule = { help?: string } & (
  | { flag: string | readonly string[] } // any of these flags appears as its own token
  | { subcommand: string }
  | { pattern: string } // RegExp source, matched against the help text
);

export interface HelpCommand {
  args: readonly string[];
  /** Only run when this capability (from an earlier help text) was seen, e.g. `exec --help` after `exec`. */
  requires?: string;
}

/**
 * One CLI Agent Studio knows how to look for. Adding a CLI = adding an entry; the scanner has no
 * per-name logic. Entries without `capabilities` are only located and version-checked: their help
 * has not been observed, so nothing is claimed about them.
 */
export interface CliCandidate {
  /** Stable id; also the key under which the probe result is stored. */
  id: string;
  displayName: string;
  /** Command name looked up on PATH (without extension). */
  command: string;
  versionArgs: readonly string[];
  /** Extra directories searched when PATH has nothing. `%VAR%` is expanded from the environment. */
  installDirs: readonly string[];
  /** Help texts to read; `main` is `--help` unless overridden. Only used when `capabilities` is non-empty. */
  helpCommands?: Record<string, HelpCommand>;
  capabilities: Record<string, CapabilityRule>;
  /**
   * Capabilities that must all be seen for the program to count as this CLI. A program that only
   * prints a version (or a vendor stub that prints "not found") is then reported but not listed as usable.
   */
  identity?: readonly string[];
}

const MAIN = { args: ["--help"] } as const;

const rule = {
  flag: (flag: string | readonly string[], help?: string): CapabilityRule => ({
    flag,
    ...(help ? { help } : {}),
  }),
  sub: (subcommand: string, help?: string): CapabilityRule => ({
    subcommand,
    ...(help ? { help } : {}),
  }),
  pattern: (pattern: string, help?: string): CapabilityRule => ({
    pattern,
    ...(help ? { help } : {}),
  }),
};

export const CLI_CANDIDATES: readonly CliCandidate[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    installDirs: ["%USERPROFILE%\\.local\\bin", "%APPDATA%\\npm"],
    capabilities: {
      print: rule.flag(["--print", "-p"]),
      outputFormat: rule.flag("--output-format"),
      outputStreamJson: rule.pattern('--output-format[\\s\\S]{0,400}?"stream-json"'),
      inputStreamJson: rule.pattern('--input-format[\\s\\S]{0,400}?"stream-json"'),
      includePartialMessages: rule.flag("--include-partial-messages"),
      verbose: rule.flag("--verbose"),
      resume: rule.flag("--resume"),
      sessionId: rule.flag("--session-id"),
      forkSession: rule.flag("--fork-session"),
      noSessionPersistence: rule.flag("--no-session-persistence"),
      permissionMode: rule.flag("--permission-mode"),
      allowedTools: rule.flag(["--allowedTools", "--allowed-tools"]),
      disallowedTools: rule.flag(["--disallowedTools", "--disallowed-tools"]),
      model: rule.flag("--model"),
      mcpConfig: rule.flag("--mcp-config"),
      jsonSchema: rule.flag("--json-schema"),
      maxBudgetUsd: rule.flag("--max-budget-usd"),
      addDir: rule.flag("--add-dir"),
    },
    identity: ["print", "outputFormat"],
  },
  {
    id: "codex",
    displayName: "Codex",
    command: "codex",
    versionArgs: ["--version"],
    installDirs: ["%APPDATA%\\npm", "%USERPROFILE%\\.local\\bin"],
    helpCommands: { main: MAIN, exec: { args: ["exec", "--help"], requires: "execSubcommand" } },
    capabilities: {
      execSubcommand: rule.sub("exec"),
      appServerSubcommand: rule.sub("app-server"),
      resumeSubcommand: rule.sub("resume"),
      execJson: rule.flag("--json", "exec"),
      execSandbox: rule.flag("--sandbox", "exec"),
      execOutputLastMessage: rule.flag("--output-last-message", "exec"),
    },
    identity: ["execSubcommand"],
  },
  {
    // Antigravity CLI. Only its `--help` text has been observed (tests/contracts/fixtures/agy).
    id: "agy",
    displayName: "Antigravity",
    command: "agy",
    versionArgs: ["--version"],
    installDirs: ["%LOCALAPPDATA%\\agy\\bin"],
    capabilities: {
      print: rule.flag(["--print", "-p"]),
      outputFormat: rule.flag("--output-format"),
      outputJson: rule.pattern("--output-format[^\\n]*\\bjson\\b"),
      outputStreamJson: rule.pattern("--output-format[^\\n]*\\bstream-json\\b"),
      inputStreamJson: rule.pattern("--input-format[^\\n]*\\bstream-json\\b"),
      model: rule.flag("--model"),
      mode: rule.flag("--mode"),
      continue: rule.flag("--continue"),
      conversation: rule.flag("--conversation"),
      sandbox: rule.flag("--sandbox"),
      dangerouslySkipPermissions: rule.flag("--dangerously-skip-permissions"),
      addDir: rule.flag("--add-dir"),
      jsonSchema: rule.flag("--json-schema"),
      modelsSubcommand: rule.sub("models"),
      mcpSubcommand: rule.sub("mcp"),
      agentsSubcommand: rule.sub("agents"),
    },
    identity: ["print", "outputFormat"],
  },
  // Located and version-checked only (command names are the vendors' documented ones).
  {
    id: "gemini",
    displayName: "Gemini CLI",
    command: "gemini",
    versionArgs: ["--version"],
    installDirs: ["%APPDATA%\\npm"],
    capabilities: {},
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    command: "copilot",
    versionArgs: ["--version"],
    installDirs: ["%APPDATA%\\npm"],
    capabilities: {},
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    command: "opencode",
    versionArgs: ["--version"],
    installDirs: ["%APPDATA%\\npm"],
    capabilities: {},
  },
  {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    command: "cursor-agent",
    versionArgs: ["--version"],
    installDirs: [],
    capabilities: {},
  },
  {
    id: "aider",
    displayName: "Aider",
    command: "aider",
    versionArgs: ["--version"],
    installDirs: ["%USERPROFILE%\\.local\\bin"],
    capabilities: {},
  },
  {
    id: "ollama",
    displayName: "Ollama",
    command: "ollama",
    versionArgs: ["--version"],
    installDirs: ["%LOCALAPPDATA%\\Programs\\Ollama"],
    capabilities: {},
  },
];

/** Evaluates one rule against the help texts read so far. A missing help text means "not seen". */
export function evalRule(r: CapabilityRule, helps: Readonly<Record<string, string>>): boolean {
  const text = helps[r.help ?? "main"];
  if (text === undefined) return false;
  if ("flag" in r)
    return (typeof r.flag === "string" ? [r.flag] : r.flag).some((f) => hasFlag(text, f));
  if ("subcommand" in r) return hasSubcommand(text, r.subcommand);
  return new RegExp(r.pattern).test(text);
}

export function capabilitiesFromHelp(
  rules: Record<string, CapabilityRule>,
  helps: Readonly<Record<string, string>>,
): Record<string, boolean> {
  return Object.fromEntries(Object.entries(rules).map(([k, r]) => [k, evalRule(r, helps)]));
}
