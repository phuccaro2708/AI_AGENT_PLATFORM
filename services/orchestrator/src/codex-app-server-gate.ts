import type { AppServerGateContext } from "@agent-studio/adapter-codex";
import type { Policy } from "@agent-studio/policy-engine";
import { levelFor } from "./policy-gate.js";

/**
 * The Policy a `codex app-server` approval request is judged against (P4-1 c).
 *
 * - Level comes from the task's permissions (`levelFor`), the workspace root is the task's working directory.
 * - NO command is on the allow list: every command Codex asks to run is `ask`/`deny` for the engine, and the
 *   adapter turns both into a decline (nobody is in that loop). A per-project allow list is future work; until
 *   then this fails closed instead of guessing which commands are harmless.
 * - File writes follow the engine's path-scope rules (inside the workspace, not under `.git`).
 *
 * Not a sandbox: it only answers the approvals Codex chooses to ask for (docs/ASSUMPTIONS.md, section c3).
 */
export function appServerPolicy(ctx: AppServerGateContext): Policy {
  return { level: levelFor(ctx.permissions), workspaceRoot: ctx.cwd, commands: { allow: [] } };
}
