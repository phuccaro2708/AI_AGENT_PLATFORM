import { detect, hasFlag, hasSubcommand, helpOf } from "./probe.js";
import type { ProbeOptions, ProbeResult } from "./types.js";

export function codexCapabilitiesFromHelp(
  top: string,
  exec: string | undefined,
): Record<string, boolean> {
  return {
    execSubcommand: hasSubcommand(top, "exec"),
    appServerSubcommand: hasSubcommand(top, "app-server"),
    resumeSubcommand: hasSubcommand(top, "resume"),
    execJson: exec !== undefined && hasFlag(exec, "--json"),
    execSandbox: exec !== undefined && hasFlag(exec, "--sandbox"),
    execOutputLastMessage: exec !== undefined && hasFlag(exec, "--output-last-message"),
  };
}

export async function probeCodex(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const det = await detect("codex", "codex", opts);
  if (!det.ok) return det.result;
  const { d, run } = det;
  const probedAt = (opts.now ?? (() => new Date()))().toISOString();
  const common = {
    provider: "codex" as const,
    path: d.exe.path,
    kind: d.exe.kind,
    version: d.version,
    probedAt,
  };

  const top = await helpOf(run, d.exe.path, ["--help"], opts);
  if ("error" in top) {
    return {
      ...common,
      status: top.error.status,
      capabilities: {},
      evidence: [],
      error: top.error,
    };
  }
  const evidence = ["parsed `codex --help`"];
  let execText: string | undefined;
  if (hasSubcommand(top.text, "exec")) {
    const ex = await helpOf(run, d.exe.path, ["exec", "--help"], opts);
    if ("error" in ex) {
      return { ...common, status: ex.error.status, capabilities: {}, evidence, error: ex.error };
    }
    execText = ex.text;
    evidence.push("parsed `codex exec --help`");
  }
  return {
    ...common,
    status: "ok",
    capabilities: codexCapabilitiesFromHelp(top.text, execText),
    evidence,
  };
}
