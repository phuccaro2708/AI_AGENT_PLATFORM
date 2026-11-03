import type { RoleDef } from "./roles.js";

/**
 * Fixed roles the sidecar offers. The UI picks agents, never role text, so a compromised or buggy
 * UI cannot smuggle instructions into a role. `access` is declared intent only (see RoleDef).
 */
export const ROLE_PRESETS = {
  implementer: {
    name: "implementer",
    instructions:
      "Implement the goal in your working directory. Finish with a short report of what you changed.",
    access: "write",
    allowedAgents: "any",
    sees: ["goal", "plan", "decision"],
  },
  reviewer: {
    name: "reviewer",
    instructions:
      "Review the change in your working directory against the goal. End with VERDICT: APPROVE or VERDICT: CHANGES_REQUESTED on its own line.",
    access: "read",
    allowedAgents: "any",
    sees: ["goal", "artifact", "report"],
  },
  supervisor: {
    name: "supervisor",
    instructions: "You plan and delegate; you do not edit files yourself.",
    access: "read",
    allowedAgents: "any",
    sees: ["goal"],
  },
  worker: {
    name: "worker",
    instructions: "Do only your own subtask. Finish with a short report of what you changed.",
    access: "write",
    allowedAgents: "any",
    sees: ["goal", "plan", "artifact", "report"],
  },
} as const satisfies Record<string, RoleDef>;
