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

export type Provider = "claude" | "codex";
export interface AgentLaunchSettings {
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface SavedAgentSettings extends AgentLaunchSettings {
  provider: string;
  verifiedAt: string;
  updatedAt: string;
}
/** Outcome of probing (or saving) launch settings. `reason` is set when `ok` is false. */
export interface SettingsOutcome {
  ok: boolean;
  reason?: string;
  resolvedPath?: string;
  probe?: CliProbe;
  settings?: SavedAgentSettings | null;
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

export type ResolveDecision = "completed" | "failed" | "cancelled" | "requeue";
export interface HistoryRow {
  taskId: string;
  workflowId: string;
  projectId: string;
  projectName: string;
  agentId: string | null;
  state: TaskState;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}
export interface HistoryFilter {
  projectId?: string;
  agentId?: string;
  state?: TaskState;
  limit?: number;
  offset?: number;
}
export interface LogHit {
  taskId: string;
  sequence: number;
  type: string;
  createdAt: string;
  snippet: string;
}

/** Typed wrappers over the allowlisted sidecar methods (docs/PROTOCOL.md). */
export const api = {
  projects: () => call<{ projects: Project[] }>("projects.list").then((r) => r.projects),
  createProject: (name: string, rootPath: string) =>
    call<{ projectId: string }>("projects.create", { name, rootPath }),
  agents: () => call<{ adapters: AdapterInfo[]; cli: CliProbe[] }>("agents.list"),
  detect: () => call<{ results: CliProbe[] }>("agents.detect", {}),
  agentSettings: (provider: Provider) =>
    call<{ settings: SavedAgentSettings | null }>("agents.getSettings", { provider }).then(
      (r) => r.settings,
    ),
  /** Checks and probes the settings without saving them. */
  probeAgent: (provider: Provider, settings: AgentLaunchSettings) =>
    call<SettingsOutcome>("agents.probe", { provider, settings }),
  /** Saves only after a successful probe; `null` restores the CLI's defaults. */
  saveAgentSettings: (provider: Provider, settings: AgentLaunchSettings | null) =>
    call<SettingsOutcome>("agents.setSettings", { provider, settings }),
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
  history: (filter: HistoryFilter) =>
    call<{ tasks: HistoryRow[] }>("tasks.history", filter).then((r) => r.tasks),
  searchLogs: (query: string, projectId?: string) =>
    call<{ hits: LogHit[] }>("logs.search", { query, ...(projectId ? { projectId } : {}) }).then(
      (r) => r.hits,
    ),
  /** A person's decision about a task whose side effects are unknown; the note is kept in the audit trail. */
  resolveReconciliation: (taskId: string, decision: ResolveDecision, note: string) =>
    call<{ state: TaskState }>("tasks.resolveReconciliation", { taskId, decision, note }),
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
