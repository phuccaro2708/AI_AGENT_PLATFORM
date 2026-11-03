import type { AgentMessage, TaskState } from "@agent-studio/contracts";
import { callSidecar as call } from "./sidecar";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
}
export interface AdapterInfo {
  id: string;
  available: boolean;
  capabilities: string[];
}
export interface CliProbe {
  provider: string;
  status: string;
  version?: string;
  path?: string;
}

export type WorkflowState = "pending" | "running" | "completed" | "failed" | "cancelled" | string;
export interface WorkflowTask {
  id: string;
  agentId: string | null;
  state: TaskState;
  createdAt: string;
}
export interface Approval {
  id: string;
  taskId: string;
  state: string;
  requestJson: string;
  expiresAt: string | null;
}
export interface ArtifactCheck {
  path: string;
  status: "ok" | "changed" | "missing";
}
export interface ContextItem {
  id: string;
  kind: string;
  content: string;
  path: string | null;
  source: string;
  createdBy: string;
}

/** Typed wrappers over the allowlisted sidecar methods (docs/PROTOCOL.md). */
export const api = {
  projects: () => call<{ projects: Project[] }>("projects.list").then((r) => r.projects),
  createProject: (name: string, rootPath: string) =>
    call<{ projectId: string }>("projects.create", { name, rootPath }),
  agents: () => call<{ adapters: AdapterInfo[]; cli: CliProbe[] }>("agents.list"),
  detect: () => call<{ results: CliProbe[] }>("agents.detect", {}),
  /** One workflow per task for now; the sidecar runs it in the project's root. */
  async startTask(projectId: string, agentId: string, prompt: string): Promise<string> {
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    const { taskId } = await call<{ taskId: string }>("workflows.start", {
      workflowId,
      agentId,
      prompt,
    });
    return taskId;
  },
  /** Creates the workflow and starts Peer Review; the sidecar picks cwd, worktree and permissions. */
  async startPeerReview(
    projectId: string,
    implementerAgent: string,
    reviewerAgent: string,
    goal: string,
  ): Promise<string> {
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    await call("workflows.startPeerReview", { workflowId, implementerAgent, reviewerAgent, goal });
    return workflowId;
  },
  workflowTasks: (workflowId: string) =>
    call<{ workflowState: WorkflowState; tasks: WorkflowTask[] }>("tasks.list", { workflowId }),
  context: (workflowId: string) =>
    call<{ items: ContextItem[] }>("context.list", { workflowId }).then((r) => r.items),
  approvals: (state?: string) =>
    call<{ approvals: Approval[] }>("approvals.list", state ? { state } : {}).then(
      (r) => r.approvals,
    ),
  resolveApproval: (approvalId: string, decision: "approved" | "denied") =>
    call("approvals.resolve", { approvalId, decision }),
  artifacts: (taskId: string) =>
    call<{ artifacts: ArtifactCheck[] }>("artifacts.list", { taskId }).then((r) => r.artifacts),
  diff: (taskId: string) =>
    call<{ patch: string; truncated: boolean }>("artifacts.diff", { taskId }),
  cancel: (taskId: string) =>
    call<{ requested: boolean; state: TaskState }>("tasks.cancel", { taskId }),
  task: (taskId: string) => call<{ state: TaskState | null }>("queryTask", { taskId }),
  logs: (taskId: string, afterSequence: number, limit = 500) =>
    call<{ messages: AgentMessage[]; nextAfterSequence: number }>("logs.query", {
      taskId,
      afterSequence,
      limit,
    }),
};
