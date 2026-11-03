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

## Delivery semantics (`MessageRouter`, services/orchestrator/src/router.ts)

- `send` writes the message (DB-derived `sequence`) and its outbox row in one transaction; a duplicate `id` is a no-op. Per-destination backpressure (`maxPendingPerConsumer`) throws `BackpressureError`.
- `tick` delivers due outbox rows: `inbox` row (message, consumer) → handler → ack + mark delivered in one transaction. At-least-once: a crash after the handler but before the ack repeats the handler, so handlers must be idempotent on `message.id`. An acked message is never handled again.
- A failing handler or missing consumer is retried with capped exponential backoff and equal jitter; after `maxAttempts` the row becomes `dead_letter`.
- Retry covers message **delivery** only. It never re-runs a task (CLAUDE.md #6).
- Not done yet: dedupe by `correlationId`, wiring the router into `Orchestrator`/scheduler (step 3). This is an internal bus; it makes no A2A claim.

## Sidecar IPC (D1)

Newline-delimited JSON on stdin/stdout: `{id, method, params?}` → `{id, result}` or `{id, error:{message}}`. Schema: `SidecarRequest` in `packages/contracts`. Requests are served concurrently, so responses may arrive out of order; match on `id`.

| method                                           | params                                                            | result                                                                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.list`                                    | –                                                                 | `{adapters:[{id,available,capabilities}], cli:[probe]}`                                                                                        |
| `agents.detect`                                  | `{providers?: ("claude"\|"codex")[]}`                             | `{results:[ProbeResult]}`; also stored in `agents`                                                                                             |
| `agents.capabilities`                            | `{provider}`                                                      | `{probe \| null}` (last stored probe)                                                                                                          |
| `projects.create` / `projects.list`              | `{name, rootPath}` / –                                            | `{projectId}` / `{projects}`                                                                                                                   |
| `workflows.create`                               | `{projectId}`                                                     | `{workflowId}`                                                                                                                                 |
| `workflows.start`                                | `{workflowId, agentId, prompt}`                                   | `{taskId}` immediately; the task runs in the background in the project's root. The UI never supplies `cwd`                                     |
| `tasks.cancel`                                   | `{taskId}`                                                        | `{requested, state}`; a running task is aborted via its signal and settles as `cancelled` (or `needs_reconciliation` if a tool was unfinished) |
| `logs.query`                                     | `{taskId, afterSequence=-1, limit=200}`                           | `{messages, nextAfterSequence}` (cursor paging)                                                                                                |
| `tasks.list`                                     | `{workflowId}`                                                    | `{workflowState, tasks}`                                                                                                                       |
| `workflows.startPeerReview`                      | `{workflowId, implementerAgent, reviewerAgent, goal, maxRounds?}` | `{workflowId, state}`                                                                                                                          |
| `roles.list` / `context.list` / `worktrees.list` | `{workflowId}`                                                    | `{roles}` / `{items}` / `{worktrees}`                                                                                                          |
| `approvals.list` / `approvals.resolve`           | `{state?}` / `{approvalId, decision, note?}`                      | `{approvals}` / `{resolved}`                                                                                                                   |
| `artifacts.list` / `artifacts.diff`              | `{taskId}`                                                        | `{artifacts}` (hash re-check) / `{patch, truncated}`                                                                                           |
| `health`, `runStub`, `queryTask`, `shutdown`     | Phase 0                                                           | unchanged; `health` adds `recoveredTasks`                                                                                                      |

### Server-pushed events (D2)

Lines with an `event` field (no `id`) are pushed on stdout: `SidecarEvent` in `packages/contracts`.

- `{event:"task.message", taskId, sequence, message}` — after the message is persisted.
- `{event:"task.state", taskId, state, reason?}` — `running`, then the final state (also on queued cancel).

Backpressure: when stdout has more than 1 MiB pending, `task.message` events are dropped (`task.state` never is). Dropping is safe because messages are persisted: on a `sequence` gap, or after reconnect, call `logs.query {taskId, afterSequence}`. A throwing listener never affects the task.

### Tauri bridge

Rust (`apps/desktop/src-tauri/src/sidecar.rs`) owns the child; a reader thread routes `id` lines to waiting requests (concurrent, matched by id, 30 s timeout) and `event` lines to the Tauri event `sidecar://event`. The UI calls `sidecar_call {method, params}` (`apps/desktop/src/sidecar.ts`); Rust only forwards the allowlist: health, queryTask, `agents.*`, `projects.*`, `workflows.*`, `tasks.*`, roles/context/approvals/artifacts/worktrees queries, logs.query (never `shutdown` or `runStub`). A dead sidecar is respawned on the next call; its pending requests fail with "sidecar exited".

Not yet: real-app run of the bridge (needs the bundled sidecar), claude tool_use/resume with the real CLI, real adapters (C2/C3 partly), path/approval policy for `rootPath` (Phase 4).
