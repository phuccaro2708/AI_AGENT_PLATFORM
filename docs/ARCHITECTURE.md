# ARCHITECTURE — Agent Workspace

Windows-first, local-first desktop platform. Trạng thái theo `docs/TODO.md` (Phase 0–2 đã đóng, Phase 7 đang làm); file này mô tả cấu trúc hiện tại, không phải lộ trình.

## Layers

| Layer        | Thành phần hiện có                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Presentation | `apps/desktop` — Vite + React (Projects, Agents, Peer Review, History, Settings); Tauri 2 shell (`src-tauri`: `sidecar.rs`, `secrets.rs`, `job.rs`)                       |
| Application  | `services/orchestrator` — sidecar Node: router/outbox, scheduler, workflow engine (Peer Review), approvals, artifacts, context board, project policy, secrets, workspaces |
| Adapter      | `packages/agent-core` (interface + registry), `adapter-claude`, `adapter-codex`; adapter giả `stub` chỉ cho test/selftest                                                 |
| Execution    | `packages/process-manager` (`shell:false`, cancel tree-kill), `packages/git-worktrees`, Job Object trong `src-tauri/src/job.rs`                                           |
| Discovery    | `packages/cli-probe` — phát hiện, probe và quét CLI (`agents.scan`)                                                                                                       |
| Persistence  | `packages/storage` — SQLite (WAL) + Drizzle migrations + `Repo`                                                                                                           |

Shared: `packages/contracts` (Zod schemas = nguồn sự thật cho type), `packages/shared-utils` (ULID, redaction, Pino logger). Contract test dùng chung ở `tests/contract` và `tests/contracts`.

## Dependency direction

`contracts` ← `shared-utils` ← `storage` / `agent-core` / `process-manager` ← `adapter-*` / `cli-probe` / `git-worktrees` ← `orchestrator` ← desktop (qua IPC allowlist `sidecar_call`)

The frontend never spawns CLIs. Mọi lệnh đi qua Tauri → sidecar NDJSON; method được phép nằm trong `ALLOWED_METHODS` (`src-tauri/src/lib.rs`).

## Module resolution

Workspace packages expose `types` → `src/index.ts` (so typecheck/tests need no prior build) and `default` → `dist/index.js` (runtime). Vitest aliases packages to `src`.

## Chưa có

Policy engine đầy đủ (Phase 4), Live Terminal (`node-pty`, Phase 5), installer (Phase 5), ACP/MCP/Skills (Phase 8), Supervisor/Parallel Workers (Phase 9). Chi tiết: `docs/ROADMAP.md`.
