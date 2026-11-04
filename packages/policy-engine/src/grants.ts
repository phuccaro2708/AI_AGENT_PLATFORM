import * as path from "node:path";
import { isWithin } from "./paths.js";
import type { Decision, Grant, GrantScope, PolicyContext } from "./types.js";

type Ask = Extract<Decision, { effect: "ask" }>;

function isActive(g: Grant, now: number): boolean {
  if (g.revokedAt !== null) return false;
  if (g.expiresAt === null) return true;
  const t = Date.parse(g.expiresAt);
  return Number.isFinite(t) && t > now; // unparsable expiry = not active (fail-closed)
}

/**
 * Which asks a grant of each scope can cover (a design choice to confirm, see ASSUMPTIONS):
 * - `path`: only `outside_scope` asks, when the canonical path lies under the grant's canonical path.
 * - `command`: only `command_unlisted` asks with exactly the same command key.
 * - `task` / `project`: `command_unlisted` and `network_unlisted` asks of that task/project; NEVER file access
 *   outside the workspace (that needs a `path` grant).
 * A grant never overrides a deny.
 */
function covers(g: Grant, ask: Ask, ctx: PolicyContext): boolean {
  if (g.target === null || g.target === "") return false;
  switch (g.scope) {
    case "path":
      return (
        ask.code === "outside_scope" && path.isAbsolute(g.target) && isWithin(g.target, ask.target)
      );
    case "command":
      return ask.code === "command_unlisted" && g.target === ask.target;
    case "task":
      return ask.code !== "outside_scope" && ctx.taskId !== undefined && ctx.taskId === g.target;
    case "project":
      return (
        ask.code !== "outside_scope" && ctx.projectId !== undefined && ctx.projectId === g.target
      );
    default:
      return false;
  }
}

export function applyGrants(ask: Ask, ctx: PolicyContext): Decision {
  const now = (ctx.now ?? new Date()).getTime();
  for (const g of ctx.grants ?? []) {
    if (isActive(g, now) && covers(g, ask, ctx)) {
      return {
        effect: "allow",
        code: "grant",
        reason: `Covered by ${g.scope} grant.`,
        grantId: g.id,
      };
    }
  }
  return ask;
}

/**
 * The `target` to store in `approval_grants` when a person approves an `ask` with `scope`.
 * Returns null when no safe target exists; the caller MUST then refuse the scope (never downgrade silently).
 */
export function grantTargetFor(scope: GrantScope, ask: Ask, ctx: PolicyContext): string | null {
  switch (scope) {
    case "path": {
      if (ask.code !== "outside_scope") return null;
      const isRoot = path.parse(ask.target).root === ask.target; // never grant a whole drive / "/"
      return isRoot ? null : ask.target;
    }
    case "command":
      return ask.code === "command_unlisted" ? ask.target : null;
    case "task":
      return ask.code !== "outside_scope" ? (ctx.taskId ?? null) : null;
    case "project":
      return ask.code !== "outside_scope" ? (ctx.projectId ?? null) : null;
    default:
      return null;
  }
}
