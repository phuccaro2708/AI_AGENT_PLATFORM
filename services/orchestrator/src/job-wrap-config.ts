import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { JobWrapOptions } from "@agent-studio/process-manager";

/** `0`/`off`/`false` turns the wrapper off (default: ON when the installed binary is found). */
export const JOB_WRAP_ENV = "AGENT_STUDIO_JOB_WRAP";
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
 * Whole-tree memory watchdog limit in MB. OFF by default (`undefined`): it only polls resident memory, so a fast
 * allocator can overshoot before it is killed; it is not a hard cap. A positive integer in
 * `AGENT_STUDIO_CLI_TREE_MEM_MB` opts in; `0`, `off` or anything else leaves it off.
 */
export function resolveTreeMemoryLimitMb(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[TREE_MEM_ENV]?.trim();
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}
