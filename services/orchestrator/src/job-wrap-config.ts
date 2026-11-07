import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { JobWrapOptions } from "@agent-studio/process-manager";

/** `0`/`off`/`false` turns the wrapper off (default: ON when the installed binary is found). */
export const JOB_WRAP_ENV = "AGENT_STUDIO_JOB_WRAP";
/** MB for the Job Object's whole-tree commit cap (`--job-mem-limit-mb`). Positive integer overrides; `0`/`off`/`false` disables. */
export const JOB_MEM_ENV = "AGENT_STUDIO_JOB_MEM_LIMIT_MB";
/**
 * Default whole-tree commit cap, in MB (Q3, 2026-11-07). Deliberately generous: the cap counts COMMITTED memory (not
 * resident), an allocation past it FAILS (Windows does not kill the process), and no commit figure of a real
 * claude/codex tree has been measured (docs/ASSUMPTIONS.md, d9). A low value could break healthy tasks in a way that
 * looks like a CLI crash, so this only stops runaway growth. Lower it with the env var once real figures exist.
 */
/** Upper bound (16 TiB in MB): anything larger is a typo and would not survive as an exact integer in argv. */
export const MAX_JOB_MEM_LIMIT_MB = 16 * 1024 * 1024;
export const DEFAULT_JOB_MEM_LIMIT_MB = 8192;
/** MB for the whole-tree watchdog (opt-in; unset, `0`, `off` or invalid = off). */
export const TREE_MEM_ENV = "AGENT_STUDIO_CLI_TREE_MEM_MB";

export interface Warn {
  warn(obj: object, msg: string): void;
}

const isOff = (v: string | undefined): boolean =>
  v !== undefined && ["0", "off", "false"].includes(v.trim().toLowerCase());

/**
 * `jobWrap` for the sidecar (P4-4 (b)). ON by default: the desktop shell passes the absolute path of the installed
 * `agent-job-wrap` (`--job-wrap`). If that file is missing or the path is not absolute the sidecar keeps running
 * WITHOUT the wrapper and logs a warning, so a broken install never fails tasks. Not a sandbox (ADR-002).
 * Also carries the default whole-tree commit cap (`jobMemLimitMb`, see `DEFAULT_JOB_MEM_LIMIT_MB`).
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
  const jobMemLimitMb = resolveJobMemLimitMb(env, log);
  return { path: location, ...(jobMemLimitMb === undefined ? {} : { jobMemLimitMb }) };
}

/** Env override (positive integer) or the default; `0`/`off`/`false` means no cap (`undefined`). Garbage = the default + a warning. */
function resolveJobMemLimitMb(env: NodeJS.ProcessEnv, log: Warn): number | undefined {
  const raw = env[JOB_MEM_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_JOB_MEM_LIMIT_MB;
  if (isOff(raw)) return undefined;
  const n = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(n) && n <= MAX_JOB_MEM_LIMIT_MB) return n;
  log.warn(
    { value: raw },
    `${JOB_MEM_ENV} is not a positive integer up to ${MAX_JOB_MEM_LIMIT_MB}: using the default`,
  );
  return DEFAULT_JOB_MEM_LIMIT_MB;
}

/**
 * Whole-tree memory watchdog limit in MB. OFF by default (`undefined`): it only polls resident memory, so a fast
 * allocator can overshoot before it is killed; it is not a hard cap. A positive integer in
 * `AGENT_STUDIO_CLI_TREE_MEM_MB` opts in; `0`, `off` or anything else leaves it off.
 */
export function resolveTreeMemoryLimitMb(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[TREE_MEM_ENV]?.trim();
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}
