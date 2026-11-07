/** `0`/`off`/`false` turns the Claude permission gate off (default: ON). */
export const CLAUDE_GATE_ENV = "AGENT_STUDIO_CLAUDE_GATE";
/** `0`/`off`/`false` stops registering the gated `codex-app-server` agent (default: ON). */
export const CODEX_GATE_ENV = "AGENT_STUDIO_CODEX_GATE";

const isOff = (v: string | undefined): boolean =>
  v !== undefined && ["0", "off", "false"].includes(v.trim().toLowerCase());

/**
 * Which permission gates the real sidecar process turns on (Q3, 2026-11-07: ON by default).
 * Only an explicit off value switches one off; an unknown value keeps it ON (fail closed).
 * The result is shaped for `SidecarOptions`: `false` = off, `undefined` = the default (on).
 */
export function resolvePermissionGates(env: NodeJS.ProcessEnv): {
  claudePermissionGate?: false;
  codexAppServer?: false;
} {
  return {
    ...(isOff(env[CLAUDE_GATE_ENV]) ? { claudePermissionGate: false as const } : {}),
    ...(isOff(env[CODEX_GATE_ENV]) ? { codexAppServer: false as const } : {}),
  };
}
