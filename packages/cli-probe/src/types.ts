export type Provider = "claude" | "codex";

/** Why a probe did not produce a usable CLI. Each maps to a clear message for the UI (B4). */
export type ProbeStatus =
  | "ok"
  | "not_installed"
  | "shim_unsupported"
  | "spawn_error"
  | "timeout"
  | "exit_nonzero"
  | "version_unparsable";

export interface ProbeError {
  status: Exclude<ProbeStatus, "ok">;
  message: string;
  /** Which command failed, e.g. "--version" or "--help". */
  step?: string;
  exitCode?: number | null;
  /** Trimmed stderr tail, for diagnostics. Never includes the prompt or environment. */
  stderrTail?: string;
}

export interface ProbeResult {
  /** `claude` / `codex` for the adapters Agent Studio runs; any candidate id for scanned CLIs. */
  provider: string;
  status: ProbeStatus;
  path?: string;
  /** `exe` can be spawned with shell:false; `shim` (.cmd/.bat) cannot. */
  kind?: "exe" | "shim";
  /** Version string as printed by the CLI (first line, trimmed). */
  version?: string;
  /**
   * Capabilities proven by the CLI's own `--help` output on this machine.
   * `false` means "not seen in help", NOT "proven absent": help text can omit hidden flags.
   */
  capabilities: Record<string, boolean>;
  /** Short facts supporting `capabilities`, e.g. which help command was parsed. */
  evidence: string[];
  error?: ProbeError;
  probedAt: string;
}

export interface CommandResult {
  outcome: "exited" | "timeout" | "cancelled" | "spawn_error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Injectable for tests. Defaults to `runProcess` from process-manager. */
export type RunFn = (opts: {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  env?: Record<string, string | undefined>;
}) => Promise<CommandResult>;

export interface ProbeOptions {
  /** Absolute path to use instead of PATH lookup (a user-configured location). */
  executable?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Arguments that print the version (default `--version`). */
  versionArgs?: readonly string[];
  run?: RunFn;
  now?: () => Date;
}
