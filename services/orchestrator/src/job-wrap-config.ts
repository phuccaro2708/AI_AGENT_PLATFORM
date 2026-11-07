import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { JobWrapOptions } from "@agent-studio/process-manager";

/** `0`/`off`/`false` turns the wrapper off (default: ON when the installed binary is found). */
export const JOB_WRAP_ENV = "AGENT_STUDIO_JOB_WRAP";
/** MB for the whole-tree watchdog; `0`/`off` turns it off; unset/invalid = the conservative default. */
export const TREE_MEM_ENV = "AGENT_STUDIO_CLI_TREE_MEM_MB";
/** Upper bound of the default tree limit. */
export const DEFAULT_TREE_MEM_CAP_MB = 8192;

export interface Warn {
  warn(obj: object, msg: string): void;
}

const isOff = (v: string | undefined): boolean =>
  v !== undefined && ["0", "off", "false"].includes(v.trim().toLowerCase());

/**
 * `jobWrap` for the sidecar (P4-4 (b)). ON by default: the desktop shell passes the absolute path of the installed
 * `agent-job-wrap` (`--job-wrap`). If that file is missing or the path is not absolute the sidecar keeps running
 * WITHOUT the wrapper and logs a warning, so a broken install never fails tasks. Not a sandbox (ADR-002).
 */
export function resolveJobWrap(
  location: string | undefined,
  env: NodeJS.ProcessEnv,
  log: Warn,
): JobWrapOptions | undefined {
  if (isOff(env[JOB_WRAP_ENV])) return undefined;
  const usable =
    location !== undefined &&
    isAbsolute(location) &&
    existsSync(location) &&
    statSync(location).isFile();
  if (!usable) {
    log.warn(
      { jobWrap: "off", hadLocation: location !== undefined },
      "agent-job-wrap not found: agent CLIs run WITHOUT a Job Object (kill-on-close / per-process memory cap)",
    );
    return undefined;
  }
  return { path: location };
}

/**
 * Whole-tree memory watchdog limit in MB, or `undefined` (off). Default: min(8192 MB, half of system RAM). Rationale:
 * a legitimate run (claude/codex plus the cargo/node builds and tests they start) can reach a few GB, so the default
 * only catches a runaway; it is a polling watchdog, not a hard cap. Override with `AGENT_STUDIO_CLI_TREE_MEM_MB`.
 */
export function resolveTreeMemoryLimitMb(
  env: NodeJS.ProcessEnv,
  totalMemBytes: number,
): number | undefined {
  const raw = env[TREE_MEM_ENV]?.trim();
  if (raw !== undefined && isOff(raw)) return undefined;
  if (raw !== undefined && /^[1-9]\d*$/.test(raw)) return Number(raw);
  const half = Math.floor(totalMemBytes / 2 / 1048576);
  return Math.max(1024, Math.min(DEFAULT_TREE_MEM_CAP_MB, half));
}
