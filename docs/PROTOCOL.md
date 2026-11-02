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

## Sidecar IPC (D1)

Newline-delimited JSON on stdin/stdout: `{id, method, params?}` → `{id, result}` or `{id, error:{message}}`. Schema: `SidecarRequest` in `packages/contracts`. Requests are served concurrently, so responses may arrive out of order; match on `id`.

| method                                       | params                                  | result                                                                                                                                         |
| -------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.list`                                | –                                       | `{adapters:[{id,available,capabilities}], cli:[probe]}`                                                                                        |
| `agents.detect`                              | `{providers?: ("claude"\|"codex")[]}`   | `{results:[ProbeResult]}`; also stored in `agents`                                                                                             |
| `agents.capabilities`                        | `{provider}`                            | `{probe \| null}` (last stored probe)                                                                                                          |
| `projects.create` / `projects.list`          | `{name, rootPath}` / –                  | `{projectId}` / `{projects}`                                                                                                                   |
| `workflows.create`                           | `{projectId}`                           | `{workflowId}`                                                                                                                                 |
| `workflows.start`                            | `{workflowId, agentId, prompt}`         | `{taskId}` immediately; the task runs in the background in the project's root. The UI never supplies `cwd`                                     |
| `tasks.cancel`                               | `{taskId}`                              | `{requested, state}`; a running task is aborted via its signal and settles as `cancelled` (or `needs_reconciliation` if a tool was unfinished) |
| `logs.query`                                 | `{taskId, afterSequence=-1, limit=200}` | `{messages, nextAfterSequence}` (cursor paging)                                                                                                |
| `health`, `runStub`, `queryTask`, `shutdown` | Phase 0                                 | unchanged; `health` adds `recoveredTasks`                                                                                                      |

Not yet: server-pushed events (D2), real adapters (C2/C3), path/approval policy for `rootPath` (Phase 4).
