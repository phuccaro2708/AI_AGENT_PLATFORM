import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyGrants } from "./grants.js";
import { canonicalize, isWithin } from "./paths.js";
import {
  commandKey,
  isInterpreter,
  matchesAllow,
  matchesDeny,
  matchesNetwork,
  normalizeHost,
  validCommand,
  validPort,
} from "./rules.js";
import { PERMISSION_LEVELS } from "./types.js";
import type { Decision, Policy, PolicyContext, PolicyRequest } from "./types.js";

const deny = (code: Extract<Decision, { effect: "deny" }>["code"], reason: string): Decision => ({
  effect: "deny",
  code,
  reason,
});

function policyProblem(policy: Policy): string | null {
  if (typeof policy !== "object" || policy === null) return "policy is not an object";
  if (!PERMISSION_LEVELS.includes(policy.level)) return "unknown permission level";
  if (typeof policy.workspaceRoot !== "string" || !path.isAbsolute(policy.workspaceRoot)) {
    return "workspaceRoot must be an absolute path";
  }
  for (const p of policy.protectedPaths ?? []) {
    const bad =
      typeof p !== "string" ||
      p === "" ||
      p.includes("\0") ||
      path.isAbsolute(p) ||
      p.split(/[\\/]/).includes("..");
    if (bad) return "protectedPaths must be relative paths without '..'";
  }
  return null;
}

async function decideFs(policy: Policy, write: boolean, rawPath: unknown): Promise<Decision> {
  if (typeof rawPath !== "string") return deny("invalid_request", "path must be a string");
  if (write && policy.level === "read_only") {
    return deny("level_forbids", "Read Only level does not allow writing.");
  }
  let workspace: string;
  try {
    workspace = await canonicalize(policy.workspaceRoot);
    if (!(await fs.stat(workspace)).isDirectory()) throw new Error("not a directory");
  } catch {
    return deny("workspace_unavailable", "Workspace folder is missing or not a folder.");
  }
  let real: string;
  try {
    real = await canonicalize(rawPath);
  } catch {
    return deny("path_unresolvable", "Path is not absolute or could not be resolved.");
  }

  if (isWithin(workspace, real)) {
    if (!write) return { effect: "allow", code: "in_workspace", reason: "Inside the workspace." };
    for (const rel of policy.protectedPaths ?? [".git"]) {
      const protectedReal = await canonicalize(path.join(workspace, rel));
      if (isWithin(protectedReal, real)) {
        return deny("protected_path", `Writing to protected path '${rel}' is never allowed.`);
      }
    }
    return { effect: "allow", code: "in_workspace", reason: "Inside the workspace." };
  }

  if (!write) {
    for (const extra of policy.extraReadRoots ?? []) {
      try {
        if (isWithin(await canonicalize(extra), real)) {
          return { effect: "allow", code: "in_read_root", reason: "Inside an extra read folder." };
        }
      } catch {
        // an unresolvable extra root grants nothing
      }
    }
  }
  if (policy.level === "privileged") {
    return { effect: "ask", code: "outside_scope", reason: "Outside the workspace.", target: real };
  }
  return deny("outside_scope", "Outside the workspace.");
}

function decideCommand(policy: Policy, executable: unknown, args: unknown): Decision {
  if (!validCommand(executable, args)) return deny("invalid_request", "malformed command");
  const exe = executable as string;
  const argv = args as readonly string[];
  if (isInterpreter(exe)) return deny("interpreter", "Shells and script hosts are never allowed.");
  if ((policy.commands?.deny ?? []).some((r) => matchesDeny(r, exe, argv))) {
    return deny("rule_deny", "Matched a deny rule.");
  }
  if (policy.level === "read_only")
    return deny("level_forbids", "Read Only level does not allow commands.");
  if ((policy.commands?.allow ?? []).some((r) => matchesAllow(r, exe, argv))) {
    return { effect: "allow", code: "rule_allow", reason: "Matched an allow rule." };
  }
  if (policy.level === "workspace_write") return deny("no_matching_rule", "No allow rule matches.");
  return {
    effect: "ask",
    code: "command_unlisted",
    reason: "Command is not in the allow list.",
    target: commandKey(exe, argv),
  };
}

function decideNetwork(policy: Policy, rawHost: unknown, port: unknown): Decision {
  const host = normalizeHost(rawHost);
  if (host === null || !validPort(port)) return deny("invalid_request", "malformed host or port");
  const p = port as number | undefined;
  if ((policy.network?.deny ?? []).some((r) => matchesNetwork(r, host, p))) {
    return deny("rule_deny", "Matched a deny rule.");
  }
  if (policy.level === "read_only")
    return deny("level_forbids", "Read Only level does not allow network.");
  if ((policy.network?.allow ?? []).some((r) => matchesNetwork(r, host, p))) {
    return { effect: "allow", code: "rule_allow", reason: "Matched an allow rule." };
  }
  if (policy.level === "workspace_write") return deny("no_matching_rule", "No allow rule matches.");
  return {
    effect: "ask",
    code: "network_unlisted",
    reason: "Host is not in the allow list.",
    target: p === undefined ? host : `${host}:${p}`,
  };
}

/**
 * Decide one request. Fail-closed: anything malformed, unknown, unresolvable or thrown is `deny`; `allow` is
 * returned only when a level + rule (or an active grant for an `ask`) explicitly permits it.
 *
 * This is a decision function. It does not enforce anything by itself: the orchestrator must call it BEFORE
 * acting, and what a CLI agent does on its own is outside its reach (see docs/SECURITY.md, ADR-002).
 */
export async function evaluate(
  policy: Policy,
  request: PolicyRequest,
  ctx: PolicyContext = {},
): Promise<Decision> {
  try {
    const problem = policyProblem(policy);
    if (problem !== null) return deny("invalid_policy", problem);
    const r = request as Record<string, unknown> | null;
    let decision: Decision;
    switch (r?.["kind"]) {
      case "fs.read":
        decision = await decideFs(policy, false, r["path"]);
        break;
      case "fs.write":
        decision = await decideFs(policy, true, r["path"]);
        break;
      case "command":
        decision = decideCommand(policy, r["executable"], r["args"]);
        break;
      case "network":
        decision = decideNetwork(policy, r["host"], r["port"]);
        break;
      default:
        return deny("invalid_request", "unknown request kind");
    }
    return decision.effect === "ask" ? applyGrants(decision, ctx) : decision;
  } catch {
    return deny("internal_error", "Evaluation failed; denied (fail-closed).");
  }
}
