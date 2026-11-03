/** Kinds of shared-board entry (see ContextBoard). `report` is an agent's own final account of its work. */
export type ContextKind = "goal" | "plan" | "decision" | "artifact" | "report";

/**
 * A role is configuration of a run, not a property of an agent: which agent fills it is decided per
 * workflow. `access` is DECLARED intent. It is not yet enforced per task: adapters fix their own
 * sandbox/tool set when constructed (today both are read-only), so a "write" role needs a
 * write-capable adapter plus policy/approval (Phase 4) before it can really write.
 */
export interface RoleDef {
  name: string;
  instructions: string;
  access: "read" | "write";
  allowedAgents: string[] | "any";
  /** Board entry kinds this role is told about. Nothing else from other agents reaches it. */
  sees: ContextKind[];
}

export function assignRole(role: RoleDef, agentId: string): void {
  if (role.allowedAgents !== "any" && !role.allowedAgents.includes(agentId)) {
    throw new Error(`agent ${agentId} is not allowed to take role ${role.name}`);
  }
}

export function buildRolePrompt(role: RoleDef, body: string): string {
  return [
    `You are acting as: ${role.name} (declared access: ${role.access}).`,
    role.instructions,
    "",
    body,
  ].join("\n");
}

export type Verdict = "approve" | "changes_requested" | "unknown";

/** The reviewer is asked to end with `VERDICT: APPROVE|CHANGES_REQUESTED` on its own line. Last one wins. */
export function parseVerdict(text: string): Verdict {
  const found = [...text.matchAll(/^VERDICT:\s*([A-Z_]+)\s*$/gm)].at(-1)?.[1];
  if (found === "APPROVE") return "approve";
  if (found === "CHANGES_REQUESTED") return "changes_requested";
  return "unknown";
}
