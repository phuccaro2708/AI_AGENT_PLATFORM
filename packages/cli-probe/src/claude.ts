import { detect, hasFlag, helpOf } from "./probe.js";
import type { ProbeOptions, ProbeResult } from "./types.js";

/**
 * Capabilities Agent Workspace would need from Claude Code, each tied to what `claude --help` prints.
 * Only the presence of a flag/value in help text is checked here; behaviour (event shapes, resume
 * semantics) is NOT verified by this probe and stays in docs/ASSUMPTIONS.md until fixture-tested.
 */
export function claudeCapabilitiesFromHelp(help: string): Record<string, boolean> {
  return {
    print: hasFlag(help, "--print") || hasFlag(help, "-p"),
    outputFormat: hasFlag(help, "--output-format"),
    outputStreamJson: /--output-format[\s\S]{0,400}?"stream-json"/.test(help),
    inputStreamJson: /--input-format[\s\S]{0,400}?"stream-json"/.test(help),
    includePartialMessages: hasFlag(help, "--include-partial-messages"),
    verbose: hasFlag(help, "--verbose"),
    resume: hasFlag(help, "--resume"),
    sessionId: hasFlag(help, "--session-id"),
    forkSession: hasFlag(help, "--fork-session"),
    noSessionPersistence: hasFlag(help, "--no-session-persistence"),
    permissionMode: hasFlag(help, "--permission-mode"),
    allowedTools: hasFlag(help, "--allowedTools") || hasFlag(help, "--allowed-tools"),
    disallowedTools: hasFlag(help, "--disallowedTools") || hasFlag(help, "--disallowed-tools"),
    model: hasFlag(help, "--model"),
    mcpConfig: hasFlag(help, "--mcp-config"),
    jsonSchema: hasFlag(help, "--json-schema"),
    maxBudgetUsd: hasFlag(help, "--max-budget-usd"),
    addDir: hasFlag(help, "--add-dir"),
  };
}

export async function probeClaude(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const det = await detect("claude", "claude", opts);
  if (!det.ok) return det.result;
  const { d, run } = det;
  const probedAt = (opts.now ?? (() => new Date()))().toISOString();
  const common = {
    provider: "claude" as const,
    path: d.exe.path,
    kind: d.exe.kind,
    version: d.version,
    probedAt,
  };

  const help = await helpOf(run, d.exe.path, ["--help"], opts);
  if ("error" in help) {
    return {
      ...common,
      status: help.error.status,
      capabilities: {},
      evidence: [],
      error: help.error,
    };
  }
  return {
    ...common,
    status: "ok",
    capabilities: claudeCapabilitiesFromHelp(help.text),
    evidence: ["parsed `claude --help`"],
  };
}
