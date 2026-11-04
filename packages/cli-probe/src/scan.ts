import { ExecutableNotFoundError, resolveExecutable } from "@agent-studio/process-manager";
import { capabilitiesFromHelp, CLI_CANDIDATES, type CliCandidate } from "./candidates.js";
import { detect, helpOf } from "./probe.js";
import type { ProbeOptions, ProbeResult } from "./types.js";

/** Per-command limit for a scan: a hung CLI must not hold up the whole list. */
export const SCAN_TIMEOUT_MS = 8_000;

export interface ScannedCli extends ProbeResult {
  displayName: string;
  /**
   * The program was found AND answered `--version` AND (when the candidate defines identity
   * capabilities) showed them in its help. `false` + a path = something with this name that is not
   * the CLI (a vendor stub, a different tool): reported, never offered.
   */
  usable: boolean;
}

export interface ScanOptions extends Omit<ProbeOptions, "executable"> {
  candidates?: readonly CliCandidate[];
}

function envGet(env: Record<string, string | undefined>, key: string): string | undefined {
  const k = Object.keys(env).find((e) => e.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : env[k];
}

/** `%VAR%` -> value; `undefined` when a variable is unset (that location does not exist here). */
export function expandDir(
  template: string,
  env: Record<string, string | undefined>,
): string | undefined {
  let missing = false;
  const out = template.replace(/%([^%]+)%/g, (_, name: string) => {
    const v = envGet(env, name);
    if (!v) missing = true;
    return v ?? "";
  });
  return missing ? undefined : out;
}

/** PATH first, then the candidate's usual install directories. Pure lookup; runs nothing. */
export function locate(c: CliCandidate, env: Record<string, string | undefined>) {
  const attempts: (Record<string, string | undefined> | undefined)[] = [undefined];
  for (const t of c.installDirs) {
    const dir = expandDir(t, env);
    if (dir) attempts.push({ PATH: dir, PATHEXT: envGet(env, "PATHEXT") });
  }
  for (const a of attempts) {
    try {
      return resolveExecutable(c.command, { env: a ?? env });
    } catch (e) {
      if (!(e instanceof ExecutableNotFoundError)) throw e;
    }
  }
  return undefined;
}

export async function scanCli(c: CliCandidate, opts: ScanOptions = {}): Promise<ScannedCli> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const probeOpts: ProbeOptions = {
    ...opts,
    env,
    timeoutMs: opts.timeoutMs ?? SCAN_TIMEOUT_MS,
  };
  const found = locate(c, env);
  const named = (r: ProbeResult, usable: boolean): ScannedCli => ({
    ...r,
    displayName: c.displayName,
    usable,
  });
  if (!found) {
    return named(
      {
        provider: c.id,
        status: "not_installed",
        capabilities: {},
        evidence: [],
        error: { status: "not_installed", message: `\`${c.command}\` was not found.` },
        probedAt: (opts.now ?? (() => new Date()))().toISOString(),
      },
      false,
    );
  }

  const det = await detect(c.id, c.command, {
    ...probeOpts,
    executable: found.path,
    versionArgs: c.versionArgs,
  });
  if (!det.ok) return named(det.result, false);
  const { d, run } = det;
  const common = {
    provider: c.id,
    path: d.exe.path,
    kind: d.exe.kind,
    version: d.version,
    probedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };

  const helps: Record<string, string> = {};
  const evidence: string[] = [];
  let caps: Record<string, boolean> = {};
  if (Object.keys(c.capabilities).length > 0) {
    const cmds = c.helpCommands ?? { main: { args: ["--help"] } };
    for (const [name, h] of Object.entries(cmds)) {
      if (h.requires && !capabilitiesFromHelp(c.capabilities, helps)[h.requires]) continue;
      const r = await helpOf(run, d.exe.path, h.args, probeOpts);
      if ("error" in r) {
        return named(
          { ...common, status: r.error.status, capabilities: {}, evidence, error: r.error },
          false,
        );
      }
      helps[name] = r.text;
      evidence.push(`parsed \`${c.command} ${h.args.join(" ")}\``);
    }
    caps = capabilitiesFromHelp(c.capabilities, helps);
  }
  const usable = (c.identity ?? []).every((k) => caps[k]);
  return named({ ...common, status: "ok", capabilities: caps, evidence }, usable);
}

/** Scans every candidate (read-only: `--version` / `--help` only) in parallel. Never throws. */
export async function scanClis(opts: ScanOptions = {}): Promise<ScannedCli[]> {
  const list = opts.candidates ?? CLI_CANDIDATES;
  return Promise.all(list.map((c) => scanCli(c, opts)));
}
