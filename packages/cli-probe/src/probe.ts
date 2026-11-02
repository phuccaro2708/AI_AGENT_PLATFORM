import {
  ExecutableNotFoundError,
  resolveExecutable,
  runProcess,
  unwrapNpmShim,
  type ResolvedExecutable,
} from "@agent-studio/process-manager";
import type {
  CommandResult,
  ProbeError,
  ProbeOptions,
  ProbeResult,
  Provider,
  RunFn,
} from "./types.js";

export const DEFAULT_TIMEOUT_MS = 15_000;

export const defaultRun: RunFn = async (o) => {
  const r = await runProcess({
    command: o.command,
    args: o.args,
    timeoutMs: o.timeoutMs,
    ...(o.env ? { env: o.env } : {}),
    maxCapture: 512 * 1024,
  });
  return {
    outcome: r.outcome,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(r.error ? { error: r.error } : {}),
  };
};

const tail = (s: string, n = 400) => s.trim().slice(-n);

/** Map a finished command to a ProbeError, or undefined when it exited 0. */
export function commandError(step: string, r: CommandResult): ProbeError | undefined {
  if (r.outcome === "timeout") {
    return { status: "timeout", step, message: `\`${step}\` did not finish in time.` };
  }
  if (r.outcome === "spawn_error" || r.outcome === "cancelled") {
    return {
      status: "spawn_error",
      step,
      message: `Could not start the CLI for \`${step}\`${r.error ? `: ${r.error}` : "."}`,
    };
  }
  if (r.exitCode !== 0) {
    return {
      status: "exit_nonzero",
      step,
      exitCode: r.exitCode,
      message: `\`${step}\` exited with code ${String(r.exitCode)}.`,
      stderrTail: tail(r.stderr),
    };
  }
  return undefined;
}

/** Pull the first dotted version number out of `--version` output. */
export function parseVersion(stdout: string): string | undefined {
  const line = stdout
    .split(/\r?\n/)
    .find((l) => l.trim().length > 0)
    ?.trim();
  if (!line || !/\d+\.\d+\.\d+/.test(line)) return undefined;
  return line.slice(0, 200);
}

/** True when `--flag` appears as its own token in help text (not as a substring of another flag). */
export function hasFlag(help: string, flag: string): boolean {
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,|\\[(])${esc}(?![\\w-])`, "m").test(help);
}

export function hasSubcommand(help: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s{1,8}${esc}(\\||\\s|$)`, "m").test(help);
}

export interface Detected {
  exe: ResolvedExecutable;
  version: string;
  versionRaw: string;
}

/** Resolve the executable and run `--version`. Returns either a Detected or a finished failure result. */
export async function detect(
  provider: Provider,
  binary: string,
  opts: ProbeOptions,
): Promise<{ ok: true; d: Detected; run: RunFn } | { ok: false; result: ProbeResult }> {
  const run = opts.run ?? defaultRun;
  const probedAt = (opts.now ?? (() => new Date()))().toISOString();
  const fail = (
    error: ProbeError,
    extra: Partial<ProbeResult> = {},
  ): { ok: false; result: ProbeResult } => ({
    ok: false,
    result: {
      provider,
      status: error.status,
      capabilities: {},
      evidence: [],
      error,
      probedAt,
      ...extra,
    },
  });

  let exe: ResolvedExecutable;
  try {
    exe = resolveExecutable(opts.executable ?? binary, opts.env ? { env: opts.env } : {});
  } catch (e) {
    if (e instanceof ExecutableNotFoundError) {
      return fail({
        status: "not_installed",
        message: `\`${binary}\` was not found on PATH. Install it and make sure it is logged in.`,
      });
    }
    return fail({ status: "spawn_error", message: e instanceof Error ? e.message : String(e) });
  }
  // An npm `.cmd` shim is fine when it can be mapped to `node <script>`; runProcess does the same mapping.
  if (exe.kind === "shim" && !unwrapNpmShim(exe)) {
    return fail(
      {
        status: "shim_unsupported",
        message: `\`${exe.path}\` is a .cmd/.bat shim that cannot be mapped to \`node <script>\`. Node cannot start it safely without a shell; install the native \`.exe\` build or set the executable path explicitly.`,
      },
      { path: exe.path, kind: "shim" },
    );
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = { command: exe.path, timeoutMs, ...(opts.env ? { env: opts.env } : {}) };
  const vr = await run({ ...base, args: ["--version"] });
  const verr = commandError("--version", vr);
  if (verr) return fail(verr, { path: exe.path, kind: exe.kind });
  const version = parseVersion(vr.stdout);
  if (!version) {
    return fail(
      {
        status: "version_unparsable",
        step: "--version",
        message: `\`--version\` printed output without a version number.`,
        stderrTail: tail(vr.stdout || vr.stderr),
      },
      { path: exe.path, kind: exe.kind },
    );
  }
  return { ok: true, d: { exe, version, versionRaw: vr.stdout }, run };
}

export async function helpOf(
  run: RunFn,
  exe: string,
  args: readonly string[],
  opts: ProbeOptions,
): Promise<{ text: string } | { error: ProbeError }> {
  const r = await run({
    command: exe,
    args,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.env ? { env: opts.env } : {}),
  });
  const step = args.join(" ");
  const err = commandError(step, r);
  if (err) return { error: err };
  return { text: r.stdout || r.stderr };
}
