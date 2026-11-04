import { z } from "zod";

export const MESSAGE_SCHEMA_VERSION = 1 as const;

export const MessageType = z.enum([
  "task.request",
  "task.accepted",
  "task.progress",
  "task.completed",
  "task.failed",
  "review.request",
  "review.result",
  "approval.request",
  "agent.message",
]);
export type MessageType = z.infer<typeof MessageType>;

export const AgentMessage = z.object({
  id: z.string().min(1),
  schemaVersion: z.literal(MESSAGE_SCHEMA_VERSION),
  workflowId: z.string().min(1),
  taskId: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  fromAgent: z.string().min(1),
  toAgent: z.string().min(1), // agent id or "orchestrator"
  type: MessageType,
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
  /** Ordering is guaranteed only within a single task stream. */
  sequence: z.number().int().nonnegative(),
});
export type AgentMessage = z.infer<typeof AgentMessage>;

export const AgentCapability = z.enum([
  "streaming",
  "session_resume",
  "tool_execution",
  "structured_output",
  "approval",
  "interactive_terminal",
  "model_selection",
]);
export type AgentCapability = z.infer<typeof AgentCapability>;

/**
 * What a task may do to its working directory. Passed to the CLI as flags where the CLI supports it,
 * but it is advisory: neither CLI confines writes to `cwd` (docs/ASSUMPTIONS.md), so it is not a sandbox.
 */
export const TaskPermissions = z.enum(["read-only", "workspace-write"]);
export type TaskPermissions = z.infer<typeof TaskPermissions>;

/** Serializable part of a task. `signal` (AbortSignal) is runtime-only, see agent-core. */
export const AgentTaskInput = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  cwd: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  /** Absent = adapter default (unchanged Phase 1 behaviour). */
  permissions: TaskPermissions.optional(),
});
export type AgentTaskInput = z.infer<typeof AgentTaskInput>;

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), content: z.string() }),
  // `callId` pairs a result with its call when the CLI reports one; without it consumers fall back to counting.
  z.object({
    type: z.literal("tool_call"),
    name: z.string(),
    args: z.unknown(),
    callId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    result: z.unknown(),
    callId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("approval"), request: z.unknown() }),
  z.object({ type: z.literal("usage"), data: z.unknown() }),
  z.object({ type: z.literal("completed"), sessionId: z.string().optional() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const WorkflowState = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowState = z.infer<typeof WorkflowState>;

export const TaskState = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "needs_reconciliation",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskState>;

// ---- Sidecar IPC (newline-delimited JSON over stdin/stdout) ----

/** Launch settings for a CLI agent. Deep checks (flags, env names, executable) happen in the sidecar. */
export const AgentLaunchSettingsInput = z.object({
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(512)).max(32).default([]),
  env: z.record(z.string().max(128), z.string().max(1024)).default({}),
});

/**
 * How far one approval reaches. `once` is the only scope that can be granted today; the others are modelled
 * (and stored in `approval_grants`) for the Policy Engine of Phase 4 and are refused by the sidecar until then.
 */
export const ApprovalScope = z.enum(["once", "task", "project", "path", "command"]);
export type ApprovalScope = z.infer<typeof ApprovalScope>;

export const SidecarRequest = z.discriminatedUnion("method", [
  z.object({ id: z.number().int(), method: z.literal("health") }),
  z.object({
    id: z.number().int(),
    method: z.literal("runStub"),
    params: z.object({ prompt: z.string() }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("queryTask"),
    params: z.object({ taskId: z.string().min(1) }),
  }),
  // ---- Phase 1 (D1). `cwd` is never sent by the UI: a workflow runs in its project's root. ----
  z.object({ id: z.number().int(), method: z.literal("agents.list") }),
  z.object({
    id: z.number().int(),
    method: z.literal("agents.detect"),
    params: z.object({ providers: z.array(z.enum(["claude", "codex"])).optional() }).default({}),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("agents.capabilities"),
    params: z.object({ provider: z.enum(["claude", "codex"]) }),
  }),
  // ---- Phase 3: look for installed CLI agents (read-only: --version / --help). No params. ----
  z.object({ id: z.number().int(), method: z.literal("agents.scan") }),
  // ---- Phase 7B: how each CLI agent is launched. Settings take effect only after a good probe. ----
  z.object({
    id: z.number().int(),
    method: z.literal("agents.getSettings"),
    params: z.object({ provider: z.enum(["claude", "codex"]) }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("agents.setSettings"),
    // `settings: null` goes back to the CLI's defaults.
    params: z.object({
      provider: z.enum(["claude", "codex"]),
      settings: AgentLaunchSettingsInput.nullable(),
    }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("agents.probe"),
    params: z.object({
      provider: z.enum(["claude", "codex"]),
      settings: AgentLaunchSettingsInput,
    }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("projects.create"),
    params: z.object({ name: z.string().trim().min(1).max(200), rootPath: z.string().min(1) }),
  }),
  // Internal: asked by the native side before it restarts the sidecar. Not in the UI allowlist.
  z.object({ id: z.number().int(), method: z.literal("system.activeTasks") }),
  z.object({ id: z.number().int(), method: z.literal("projects.list") }),
  z.object({
    id: z.number().int(),
    method: z.literal("workflows.create"),
    params: z.object({ projectId: z.string().min(1) }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("workflows.start"),
    params: z.object({
      workflowId: z.string().min(1),
      agentId: z.string().min(1),
      prompt: z.string().min(1).max(100_000),
    }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("tasks.cancel"),
    params: z.object({ taskId: z.string().min(1) }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("logs.query"),
    params: z.object({
      taskId: z.string().min(1),
      afterSequence: z.number().int().min(-1).default(-1),
      limit: z.number().int().min(1).max(1000).default(200),
    }),
  }),
  // ---- Phase 2. Read-mostly: the UI never picks `cwd`, worktrees or permissions. ----
  z.object({
    id: z.number().int(),
    method: z.literal("tasks.list"),
    params: z.object({ workflowId: z.string().min(1) }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("workflows.startPeerReview"),
    params: z.object({
      workflowId: z.string().min(1),
      implementerAgent: z.string().min(1),
      reviewerAgent: z.string().min(1),
      goal: z.string().min(1).max(100_000),
      maxRounds: z.number().int().min(1).max(5).optional(),
    }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("roles.list"),
    params: z.object({ workflowId: z.string().min(1) }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("context.list"),
    params: z.object({ workflowId: z.string().min(1) }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("approvals.list"),
    params: z
      .object({ state: z.enum(["pending", "approved", "denied", "expired"]).optional() })
      .default({}),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("approvals.resolve"),
    params: z.object({
      approvalId: z.string().min(1),
      decision: z.enum(["approved", "denied"]),
      note: z.string().max(2000).optional(),
      /** Only "once" is honoured until the Policy Engine exists (Phase 4); other scopes are rejected, never downgraded silently. */
      scope: ApprovalScope.default("once"),
    }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("artifacts.list"),
    params: z.object({ taskId: z.string().min(1) }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("artifacts.diff"),
    params: z.object({ taskId: z.string().min(1) }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("worktrees.list"),
    params: z.object({ workflowId: z.string().min(1) }),
  }),
  // ---- Phase 7A: history and log search (read-only) ----
  z.object({
    id: z.number().int(),
    method: z.literal("tasks.history"),
    params: z
      .object({
        projectId: z.string().min(1).optional(),
        agentId: z.string().min(1).optional(),
        state: TaskState.optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .default({ limit: 50, offset: 0 }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("tasks.resolveReconciliation"),
    params: z.object({
      taskId: z.string().min(1),
      decision: z.enum(["completed", "failed", "cancelled", "requeue"]),
      // What the person checked; kept in the audit trail, so it cannot be empty.
      note: z.string().trim().min(3).max(2000),
    }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("logs.search"),
    params: z.object({
      query: z.string().trim().min(2).max(200),
      projectId: z.string().min(1).optional(),
      taskId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  }),
  z.object({ id: z.number().int(), method: z.literal("shutdown") }),
]);
export type SidecarRequest = z.infer<typeof SidecarRequest>;

/**
 * Server-pushed line (no `id`). Lossy by design under backpressure: a client that sees a gap in
 * `sequence` (or reconnects) recovers with `logs.query {afterSequence}`, which is the source of truth.
 * `task.state` is never dropped.
 */
export const SidecarEvent = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("task.message"),
    taskId: z.string(),
    sequence: z.number().int(),
    message: AgentMessage,
  }),
  z.object({
    event: z.literal("task.state"),
    taskId: z.string(),
    state: TaskState,
    reason: z.string().optional(),
  }),
]);
export type SidecarEvent = z.infer<typeof SidecarEvent>;

export const SidecarResponse = z.union([
  z.object({ id: z.number().int(), result: z.unknown() }),
  z.object({ id: z.number().int().nullable(), error: z.object({ message: z.string() }) }),
]);
export type SidecarResponse = z.infer<typeof SidecarResponse>;

// ---- Task state machine (design decision, not a CLI capability) ----

/**
 * Allowed task state transitions. Terminal states have no outgoing edges.
 * `needs_reconciliation` is left only by an explicit human/recovery decision
 * (requeue, or settle as completed/failed/cancelled); there is no automatic retry.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "needs_reconciliation", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "needs_reconciliation", "failed", "cancelled"],
  needs_reconciliation: ["queued", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TASK_TRANSITIONS[state].length === 0;
}

/** Allowed workflow state transitions. Terminal states have no outgoing edges. */
export const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  pending: ["running", "cancelled"],
  running: ["paused", "completed", "failed", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionWorkflow(from: WorkflowState, to: WorkflowState): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

export function isTerminalWorkflowState(state: WorkflowState): boolean {
  return WORKFLOW_TRANSITIONS[state].length === 0;
}

// ---- Message payloads (only the types that carry structure the engine reads) ----

const Sha256 = z.string().length(64);

export const ReviewRequestPayload = z.object({
  summary: z.string(),
  artifacts: z.array(z.object({ path: z.string().min(1), sha256: Sha256 })),
});
export const ReviewResultPayload = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  comments: z.array(z.string()),
});
export const ApprovalRequestPayload = z.object({
  approvalId: z.string().min(1),
  description: z.string(),
});
export const AgentMessagePayload = z.object({ text: z.string() });

const PAYLOAD_SCHEMAS: Partial<Record<MessageType, z.ZodType>> = {
  "review.request": ReviewRequestPayload,
  "review.result": ReviewResultPayload,
  "approval.request": ApprovalRequestPayload,
  "agent.message": AgentMessagePayload,
};

/** Validates a payload for types with a schema; other types (task.*) stay free-form. */
export function parseMessagePayload(type: MessageType, payload: unknown) {
  return (PAYLOAD_SCHEMAS[type] ?? z.unknown()).safeParse(payload);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Illegal task transition for ${taskId}: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}
