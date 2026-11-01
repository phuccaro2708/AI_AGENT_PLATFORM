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
  z.object({ id: z.number().int(), method: z.literal("shutdown") }),
]);
export type SidecarRequest = z.infer<typeof SidecarRequest>;

export const SidecarResponse = z.union([
  z.object({ id: z.number().int(), result: z.unknown() }),
  z.object({ id: z.number().int().nullable(), error: z.object({ message: z.string() }) }),
]);
export type SidecarResponse = z.infer<typeof SidecarResponse>;
