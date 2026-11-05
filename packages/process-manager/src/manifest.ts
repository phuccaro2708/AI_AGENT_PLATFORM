/**
 * Per-adapter spawn manifest (Phase 4, P4-3): which executables an adapter may start and which environment
 * variables its child may see. It is enforced at ONE place, `startProcess`; an adapter only declares it.
 * It limits what THIS process hands to a child by accident or through a bug. It is not a sandbox: the child
 * can still do whatever the user account can do (docs/SECURITY.md, ADR-002).
 */
export interface SpawnManifest {
  /** Executable names that may be started, e.g. `claude`. Compared on the base name, without `.exe/.cmd/.bat/.com`. */
  executables: readonly string[];
  /** Environment variable names that reach the child (exact; case-insensitive on Windows). */
  env: readonly string[];
  /** Name prefixes that reach the child, e.g. `ANTHROPIC_`. Keep them provider specific. */
  envPrefixes?: readonly string[];
}

export class SpawnDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnDeniedError";
  }
}

/**
 * What every CLI child needs to start and to reach the network, and nothing that changes how the runtime loads
 * code (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `PYTHONPATH`…) or that carries credentials (those come only
 * from the adapter's own prefixes or from variables the host names explicitly).
 */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

const fold = (s: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? s.toLowerCase() : s;

/** Name used to compare executables: base name, lower case, no Windows launcher extension. */
export function executableName(command: string): string {
  const last = command.split(/[\\/]/).pop() ?? "";
  return last.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

/** Adds executables / variable names to a manifest without changing the original. */
export function extendManifest(
  base: SpawnManifest,
  extra: { executables?: readonly string[]; env?: readonly string[] },
): SpawnManifest {
  return {
    executables: [...base.executables, ...(extra.executables ?? [])],
    env: [...base.env, ...(extra.env ?? [])],
    ...(base.envPrefixes ? { envPrefixes: base.envPrefixes } : {}),
  };
}

/** Throws `SpawnDeniedError` unless the command's base name is declared. An empty list allows nothing. */
export function assertExecutableAllowed(manifest: SpawnManifest, command: string): void {
  const name = executableName(command);
  if (name === "" || !manifest.executables.some((e) => executableName(e) === name)) {
    throw new SpawnDeniedError(`Executable not allowed by the adapter manifest: ${command}`);
  }
}

/**
 * The environment the child gets: only declared names, never `undefined` values. Names are compared
 * case-insensitively on Windows (where `Path` and `PATH` are the same variable); the original spelling is kept.
 */
export function filterEnv(
  manifest: SpawnManifest,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const names = new Set(manifest.env.map((n) => fold(n, platform)));
  const prefixes = (manifest.envPrefixes ?? []).map((p) => fold(p, platform));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = fold(name, platform);
    if (names.has(key) || prefixes.some((p) => key.startsWith(p))) out[name] = value;
  }
  return out;
}
