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

## Delivery semantics (partly implemented, Phase 2 slice 1)

At-least-once with idempotent handlers. `appendMessageWithOutbox` writes the message and a pending `outbox` row (one per recipient) in one transaction. `Router.deliverDue` runs due rows, records receipt in `inbox` (dedupe by message id), retries with exponential backoff + full jitter (1 s base, 60 s cap), dead-letters after `maxAttempts`. Not yet: dedupe by `correlationId`, background tick loop, wiring into the orchestrator.

## Sidecar IPC (D1)

Newline-delimited JSON on stdin/stdout: `{id, method, params?}` → `{id, result}` or `{id, error:{message}}`. Schema: `SidecarRequest` in `packages/contracts`. Requests are served concurrently, so responses may arrive out of order; match on `id`.

| method                                       | params                                                                | result                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.list`                                | –                                                                     | `{adapters:[{id,available,capabilities}], cli:[probe]}`                                                                                                         |
| `agents.detect`                              | `{providers?: ("claude"\|"codex")[]}`                                 | `{results:[ProbeResult]}`; also stored in `agents`                                                                                                              |
| `agents.capabilities`                        | `{provider}`                                                          | `{probe \| null}` (last stored probe)                                                                                                                           |
| `projects.create` / `projects.list`          | `{name, rootPath}` / –                                                | `{projectId}` / `{projects}`                                                                                                                                    |
| `workflows.create`                           | `{projectId}`                                                         | `{workflowId}`                                                                                                                                                  |
| `workflows.start`                            | `{workflowId, agentId, prompt}`                                       | `{taskId}` immediately; the task runs in the background in the project's root. The UI never supplies `cwd`                                                      |
| `tasks.cancel`                               | `{taskId}`                                                            | `{requested, state}`; a running task is aborted via its signal and settles as `cancelled` (or `needs_reconciliation` if a tool was unfinished)                  |
| `logs.query`                                 | `{taskId, afterSequence=-1, limit=200}`                               | `{messages, nextAfterSequence}` (cursor paging)                                                                                                                 |
| `workflows.runPeerReview`                    | `{workflowId, goal, implementerAgentId, reviewerAgentId}`             | `{started:true}`; runs in the background with fixed role presets (`role-presets.ts`); the UI never sends role text or `cwd`. One pattern per workflow at a time |
| `workflows.runSupervised`                    | `{workflowId, goal, supervisorAgentId, workerAgentIds, maxSubtasks?}` | `{started:true}`; background                                                                                                                                    |
| `workflows.state`                            | `{workflowId}`                                                        | `{state, patternRunning}`                                                                                                                                       |
| `context.list`                               | `{workflowId}`                                                        | `{entries}` — agent-written text, render as plain text                                                                                                          |
| `approvals.list` / `approvals.resolve`       | `{taskId?}` / `{approvalId, decision:"approved"                       | "denied", reason?}`                                                                                                                                             | `{approvals}` / `{resolved}`; `resolved_by` is fixed to `user:local` by the sidecar (no client identity yet) |
| `health`, `runStub`, `queryTask`, `shutdown` | Phase 0                                                               | unchanged; `health` adds `recoveredTasks`                                                                                                                       |

### Server-pushed events (D2)

Lines with an `event` field (no `id`) are pushed on stdout: `SidecarEvent` in `packages/contracts`.

- `{event:"task.message", taskId, sequence, message}` — after the message is persisted.
- `{event:"task.state", taskId, state, reason?}` — `running`, then the final state (also on queued cancel).

Backpressure: when stdout has more than 1 MiB pending, `task.message` events are dropped (`task.state` never is). Dropping is safe because messages are persisted: on a `sequence` gap, or after reconnect, call `logs.query {taskId, afterSequence}`. A throwing listener never affects the task.

Phase 2 events: `{event:"approval.changed", approvalId, taskId, state: pending|approved|denied|expired}` and `{event:"workflow.finished", workflowId, pattern, outcome, error?}` (not pushed after `close`). They have no `sequence`; recover with `approvals.list` / `workflows.state`. Pending approvals are swept for expiry every 5 s.

### Tauri bridge

Rust (`apps/desktop/src-tauri/src/sidecar.rs`) owns the child; a reader thread routes `id` lines to waiting requests (concurrent, matched by id, 30 s timeout) and `event` lines to the Tauri event `sidecar://event`. The UI calls `sidecar_call {method, params}` (`apps/desktop/src/sidecar.ts`); Rust only forwards the allowlist: health, queryTask, agents._, projects._, workflows._, tasks.cancel, logs.query, context.list, approvals._ (never `shutdown` or `runStub`). A dead sidecar is respawned on the next call; its pending requests fail with "sidecar exited".

Not yet: real-app run of the bridge (needs the bundled sidecar), claude tool_use/resume with the real CLI, real adapters (C2/C3 partly), path/approval policy for `rootPath` (Phase 4).
