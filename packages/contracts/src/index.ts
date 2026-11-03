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

/** Serializable part of a task. `signal` (AbortSignal) is runtime-only, see agent-core. */
export const AgentTaskInput = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  cwd: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});
export type AgentTaskInput = z.infer<typeof AgentTaskInput>;

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), content: z.string() }),
  z.object({ type: z.literal("tool_call"), name: z.string(), args: z.unknown() }),
  z.object({ type: z.literal("tool_result"), result: z.unknown() }),
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
  z.object({
    id: z.number().int(),
    method: z.literal("projects.create"),
    params: z.object({ name: z.string().trim().min(1).max(200), rootPath: z.string().min(1) }),
  }),
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
  // ---- Phase 2: multi-agent patterns, shared context, approvals. Agents/roles are chosen by id; role
  // instructions and `cwd` are never sent by the UI. `resolvedBy` is fixed by the sidecar. ----
  z.object({
    id: z.number().int(),
    method: z.literal("workflows.runPeerReview"),
    params: z.object({
      workflowId: z.string().min(1),
      goal: z.string().min(1).max(100_000),
      implementerAgentId: z.string().min(1),
      reviewerAgentId: z.string().min(1),
    }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("workflows.runSupervised"),
    params: z.object({
      workflowId: z.string().min(1),
      goal: z.string().min(1).max(100_000),
      supervisorAgentId: z.string().min(1),
      workerAgentIds: z.array(z.string().min(1)).min(1).max(8),
      maxSubtasks: z.number().int().min(1).max(16).optional(),
    }),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("workflows.state"),
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
    params: z.object({ taskId: z.string().min(1).optional() }).default({}),
  }),
  z.object({
    id: z.number().int(),
    method: z.literal("approvals.resolve"),
    params: z.object({
      approvalId: z.string().min(1),
      decision: z.enum(["approved", "denied"]),
      reason: z.string().max(2000).optional(),
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
  z.object({
    event: z.literal("approval.changed"),
    approvalId: z.string(),
    taskId: z.string(),
    state: z.enum(["pending", "approved", "denied", "expired"]),
  }),
  z.object({
    event: z.literal("workflow.finished"),
    workflowId: z.string(),
    pattern: z.enum(["peer_review", "supervised"]),
    outcome: z.string(),
    error: z.string().optional(),
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
