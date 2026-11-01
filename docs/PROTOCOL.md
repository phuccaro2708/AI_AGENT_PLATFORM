# PROTOCOL — internal message protocol (v1)

Defined in `packages/contracts/src/index.ts` (Zod). This is an **internal** protocol; it is not A2A and must not be called "A2A-compatible" (ADR-003).

## AgentMessage

`id, schemaVersion(=1), workflowId, taskId, correlationId, causationId?, fromAgent, toAgent ("orchestrator" or agent id), type, payload, createdAt (ISO-8601), sequence`.

Types: `task.request|accepted|progress|completed|failed`, `review.request|result`, `approval.request`, `agent.message`.

Ordering is guaranteed only within one task stream (`UNIQUE(task_id, sequence)`), not across parallel agents.

## AgentEvent (adapter → orchestrator)

`text | tool_call | tool_result | approval | usage | completed | error`. Cancellation in the stub is reported as `{type:"error", message:"cancelled"}`; the orchestrator maps it to task state `cancelled`. (Convention for Phase 0; revisit with real adapters.)

## Phase 0 mapping (orchestrator)

`task.accepted` → every adapter event as `task.progress` → final `task.completed` (on `completed`) or `task.failed` (on `error`/exception).

## Delivery semantics (target, NOT implemented yet)

At-least-once, idempotent handlers, outbox/inbox, retry with backoff+jitter, dead-letter queue — Phase 2.
