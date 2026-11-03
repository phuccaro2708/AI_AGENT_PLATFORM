# ARCHITECTURE — Agent Studio (Phase 0)

Windows-first, local-first desktop platform. Phase 0 delivers the foundation only; no real CLI agent is integrated yet.

## Layers

| Layer        | Phase 0 status                                                              |
| ------------ | --------------------------------------------------------------------------- |
| Presentation | `apps/desktop` — Vite + React health screen; Tauri 2 shell (`src-tauri`)    |
| Application  | `services/orchestrator` — runs ONE task on ONE adapter, persists messages   |
| Adapter      | `packages/agent-core` — `AgentAdapter` interface, registry, `StubAdapter`   |
| Execution    | Not implemented (Phase 1: process manager, `shell:false`, cancel tree-kill) |
| Persistence  | `packages/storage` — SQLite (WAL) + Drizzle migrations + thin `Repo`        |

Shared: `packages/contracts` (Zod schemas = source of truth for types), `packages/shared-utils` (ULID ids, redaction, Pino logger).

## Dependency direction

`contracts` ← `shared-utils` ← `storage` / `agent-core` ← `orchestrator` ← (desktop via IPC, later)

The frontend never spawns CLIs. Its only native entry point in Phase 0 is the Tauri command `system_health`.

## Module resolution

Workspace packages expose `types` → `src/index.ts` (so typecheck/tests need no prior build) and `default` → `dist/index.js` (runtime). Vitest aliases packages to `src`.

## Not in Phase 0

Scheduler, router/outbox, DAG, worktrees, policy engine, real adapters, sidecar packaging (spike pending, see `DECISIONS.md` ADR-001).

## Phase 2: điều phối nhiều agent

Sidecar giữ thêm: `Scheduler` (lease, DAG, concurrency), `MessageRouter` (outbox/inbox bền, at-least-once + dedupe), `PeerReviewEngine` (implementer → reviewer, vòng `request_changes`), `ContextBoard` (lọc theo vai), `ApprovalService`, `ArtifactRegistry` và `ProjectWorkspaces` (git worktree riêng cho mỗi workflow). Task đang chạy mà lease hết hạn hoặc tiến trình chết → `needs_reconciliation`, không bao giờ tự chạy lại. Worktree và approval không phải sandbox. Chi tiết và ngoại lệ: `docs/PHASE2_REPORT.md`, `docs/ASSUMPTIONS.md`.
