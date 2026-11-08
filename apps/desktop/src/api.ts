import type { AgentMessage, TaskState } from "@agent-studio/contracts";
import { AUTO_AGENT } from "./autoRoute";
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
  capabilities?: Record<string, boolean>;
}

/** One CLI looked for by `agents.scan`. `supported`: Agent Studio has an adapter that can run tasks with it. */
export interface ScannedCli extends CliProbe {
  id: string;
  displayName: string;
  supported: boolean;
  /** Found, answered `--version` and looks like the real CLI. */
  usable: boolean;
  probedAt?: string;
  error?: { message: string };
}

export interface DiagnosticsExport {
  dir: string;
  manifestPath: string;
  files: { path: string; bytes: number }[];
  verified: boolean;
  problems: string[];
  limits: string;
}

export interface Band {
  reduceAt: number;
  pauseAt: number;
}
/** Load limits kept in the settings table (P3-4, P3-5). Percentages 0-100, concurrency 1-8. */
export interface ResourceSettings {
  concurrency: number;
  thresholds: { cpu: Band; memory: Band; releaseMarginPercent: number };
}
export interface ResourceReport {
  settings: ResourceSettings;
  defaults: ResourceSettings;
  status: {
    concurrency: number;
    /** What the scheduler may start at once right now: the ceiling, halved or zero under load. */
    effectiveConcurrency: number;
    running: number;
    queued: number;
    monitor: {
      level: "normal" | "reduced" | "paused";
      reasons: string[];
      measured: boolean;
      cpuPercent?: number;
      memoryPercent?: number;
      trackedRssBytes?: number;
    } | null;
  };
}

export type RecoveryAction = "resume" | "retry" | "abandon";
/** What `recovery.inspect` found out about a task that stopped with unknown side effects. */
export interface RecoveryReport {
  taskId: string;
  state: TaskState;
  attempt: number;
  classification: "no_evidence_of_side_effects" | "side_effects_unverified";
  evidence: {
    messageCount: number;
    producedOutput: boolean;
    toolCalls: number;
    unfinishedToolCalls: number;
    hasStoredPrompt: boolean;
    hasWorktree: boolean;
    worktreeChanged: boolean | null;
    flaggedByPolicy: boolean;
  };
  actions: Record<RecoveryAction, { allowed: boolean; confirmation: boolean; why?: string }>;
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
  createdAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  decidedBy: string | null;
  decisionScope: string | null;
  decisionNote: string | null;
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
  scan: () => call<{ clis: ScannedCli[] }>("agents.scan"),
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
  async startTask(
    projectId: string,
    agentId: string,
    prompt: string,
    /** Used only for `AUTO_AGENT`: ids the router must not pick. */
    excludeAgents: string[] = [],
  ): Promise<string> {
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    const auto = agentId === AUTO_AGENT;
    const { taskId } = await call<{ taskId: string }>("workflows.start", {
      workflowId,
      ...(auto ? { excludeAgents } : { agentId }),
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
  resolveApproval: (approvalId: string, decision: "approved" | "denied", note?: string) =>
    call("approvals.resolve", { approvalId, decision, ...(note ? { note } : {}) }),
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
  /** Read-only evidence and what each recovery action needs (P4-8). */
  inspectRecovery: (taskId: string) => call<RecoveryReport>("recovery.inspect", { taskId }),
  /** resume = keep what exists and continue; retry = run again (attempt + 1); abandon = cancel. Never automatic. */
  recover: (taskId: string, action: RecoveryAction, note: string, confirmUnverified: boolean) =>
    call<{ state: TaskState }>("recovery.resolve", { taskId, action, note, confirmUnverified }),
  /** A redacted support bundle written next to the database; the UI cannot choose where. */
  exportDiagnostics: () => call<DiagnosticsExport>("diagnostics.export"),
  getResources: () => call<ResourceReport>("resources.get"),
  /** Validated by the backend; a bad value is rejected and nothing changes. Applies to later tasks at once. */
  setResources: (settings: ResourceSettings) => call<ResourceReport>("resources.set", { settings }),
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
