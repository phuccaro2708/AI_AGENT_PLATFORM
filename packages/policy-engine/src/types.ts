import type { ApprovalScope } from "@agent-studio/contracts";

/** Four permission levels (ROADMAP Phase 4). Ordered from least to most capable. */
export const PERMISSION_LEVELS = [
  "read_only",
  "workspace_write",
  "restricted_tools",
  "privileged",
] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/**
 * Scopes a stored grant can have: every `ApprovalScope` except `once` (a one-time approval is consumed by the
 * approval itself and never becomes a grant). Derived from the contract so the two cannot drift apart.
 */
export type GrantScope = Exclude<ApprovalScope, "once">;

export interface CommandRule {
  /** Matched exactly (case-insensitive on Windows). A bare name never matches a path-qualified executable. */
  executable: string;
  /** If set, the request's arguments must start with these. Omitted = any arguments. */
  argsPrefix?: readonly string[];
}

export interface NetworkRule {
  /** `example.com` (exact) or `*.example.com` (subdomains only, not the apex). */
  host: string;
  /** If set, the request must name one of these ports. Omitted = any port. */
  ports?: readonly number[];
}

export interface Policy {
  level: PermissionLevel;
  /** Absolute path of the folder the agent works in. Must exist; otherwise every file request is denied. */
  workspaceRoot: string;
  /** Extra absolute folders that may be READ (never written). */
  extraReadRoots?: readonly string[];
  /** Paths relative to `workspaceRoot` that can never be written. Default `[".git"]`. */
  protectedPaths?: readonly string[];
  commands?: { allow?: readonly CommandRule[]; deny?: readonly CommandRule[] };
  network?: { allow?: readonly NetworkRule[]; deny?: readonly NetworkRule[] };
}

export type PolicyRequest =
  | { kind: "fs.read"; path: string }
  | { kind: "fs.write"; path: string }
  | { kind: "command"; executable: string; args: readonly string[] }
  | { kind: "network"; host: string; port?: number };

/** A stored "always allow in this scope" decision (mirrors a row of `approval_grants`). */
export interface Grant {
  id: string;
  scope: GrantScope;
  /** task id | project id | canonical path (prefix) | command key (see `commandKey`). */
  target: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface PolicyContext {
  taskId?: string;
  projectId?: string;
  grants?: readonly Grant[];
  /** Injected for tests. Defaults to the current time. */
  now?: Date;
}

/** Why a request needs a person: it is outside what the level + rules allow, but a person may widen it. */
export type AskKind = "outside_scope" | "command_unlisted" | "network_unlisted";

export type AllowCode = "in_workspace" | "in_read_root" | "rule_allow" | "grant";
export type DenyCode =
  | "invalid_request"
  | "invalid_policy"
  | "path_unresolvable"
  | "workspace_unavailable"
  | "level_forbids"
  | "outside_scope"
  | "protected_path"
  | "interpreter"
  | "rule_deny"
  | "no_matching_rule"
  | "internal_error";

export type Decision =
  | { effect: "allow"; code: AllowCode; reason: string; grantId?: string }
  /** `target` is what a grant would store: canonical path, `commandKey`, or `host[:port]`. */
  | { effect: "ask"; code: AskKind; reason: string; target: string }
  | { effect: "deny"; code: DenyCode; reason: string };
