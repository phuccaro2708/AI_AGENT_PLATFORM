# TODO — Agent Studio

Đánh dấu `[x]` khi xong **và đã kiểm chứng**. Ngữ cảnh/acceptance: `docs/ROADMAP.md`.

## Trạng thái hiện tại (cập nhật 2026-11-01)

- **Phase 0: PASS (có hạn chế)** — xem `docs/PHASE0_REPORT.md`, `docs/reports/phase0-windows/README.md`. CI xanh trên runner Windows/Ubuntu (run 9, commit `d9cf954`); đã xác minh trên máy Windows vật lý (Legion) bằng bản `tauri dev`.
- **Phase 1: backlog đã đề xuất, chưa bắt đầu.** Chờ người dùng xác nhận Sprint A và cho biết CLI nào đã cài.
- Chưa có PR; nhánh làm việc `claude/loving-lovelace-32lh71`.

## Phase 0 — Foundation (HOÀN THÀNH, có hạn chế)

### Repo & tooling

- [x] `pnpm-workspace.yaml`, `package.json` gốc, `.nvmrc`, `.gitignore`, `.editorconfig`, `.gitattributes` (LF)
- [x] ESLint + Prettier + `tsconfig.base.json` (strict)
- [x] Vitest cấu hình dùng chung
- [x] Scripts gốc: `lint`, `typecheck`, `test`, `build`, `format`
- [x] GitHub Actions: ts (ubuntu + windows), tauri (Rust windows), security, desktop-smoke
- [x] Secret scan trong CI — dùng `detect-secrets` (gitleaks bị proxy chặn khi tải); 7 kết quả lịch sử đã chấp nhận, ghi trong `scripts/secret-scan.py`
- [x] `README.md`

### Packages

- [x] `packages/contracts`: Zod schema (AgentMessage, AgentEvent, AgentTaskInput, AgentCapability, WorkflowState, TaskState, giao thức sidecar)
- [~] `packages/shared-utils`: có id (ULID), redact, logger; **chưa có** clock và result type (làm khi cần)
- [x] `packages/agent-core`: `AgentAdapter` + registry + `StubAdapter`
- [x] `packages/storage`: Drizzle schema, migration, WAL, repo layer, test
- [x] Bảng Phase 0: projects, workflows, tasks, task_dependencies, messages, events, settings
- [x] Logging Pino + redaction + test

### Apps/services

- [~] `apps/desktop`: Vite + React + màn hình health; **Tailwind/shadcn/Zustand/TanStack Query chưa thêm** (chưa cần)
- [x] `apps/desktop/src-tauri`: Tauri 2, capabilities tối thiểu, `system_health` (tên thực tế)
- [x] `services/orchestrator`: chạy StubAdapter end-to-end qua sidecar NDJSON
- [~] Spike sidecar: Node + `better-sqlite3` đạt trên runner và máy thật; **`node-pty` chưa spike** (cần cho Live Terminal, Phase 5). Kết quả trong `docs/ADR-001.md`

### Docs

- [x] ARCHITECTURE, PROTOCOL, DATABASE, SECURITY, ASSUMPTIONS, REFERENCES, DECISIONS, ADR-001
- [x] PHASE0_REPORT.md

### Việc mang sang các phase sau (từ Phase 0)

- [ ] Build installer và đo kích thước (Phase 5)
- [ ] Chạy lại kiểm tra trên máy Windows vật lý với bản **release**, ghi hash commit đã test
- [ ] Job Object / dọn process tree (Phase 1 spike A2, hoàn thiện Phase 4)
- [ ] Ghim GitHub Actions theo SHA; kiểm tra tuổi crate Rust theo quy tắc 14 ngày
- [ ] Hai cảnh báo `pnpm audit` mức moderate (dev-only) và hai cảnh báo `cargo audit` (transitive)
- [ ] Spike `node-pty` trên Windows

## Phase 1 — Single-Agent MVP (backlog đã đề xuất, chưa bắt đầu)

Điều kiện cần quyết định trước: CLI nào đã cài/đăng nhập trên Legion; chi phí test thật (ưu tiên fixture); Job Object ở Rust hay `taskkill /T` (ADR-004).

### Sprint A — Nền tảng chạy process (không cần CLI thật)

- [x] A1. Process Manager (`spawn`, `shell:false`, stream, timeout, cancel, resolve shim Windows)
- [x] A2. Spike Job Object / kill tree + test không orphan → ADR-004
- [x] A3. Task state machine + transition guard + test
- [x] A4. Migration: sessions, execution_runs, artifacts, approvals
- [x] A5. Log sink cho stderr của sidecar (hiện `Stdio::null()`)

### Sprint B — Phát hiện CLI và probe

- [~] B1. Detection + probe Claude Code (version, flags thực tế) — `packages/cli-probe`; đã chạy thật với `claude` 2.1.316 trong container Linux (không phải Legion); chưa probe trên Legion
- [~] B2. Detection + probe Codex (version, `app-server`, `exec --json`) — code xong, test chỉ bằng help **giả lập**; `codex` chưa cài trong container nên chưa có output thật
- [~] B3. (chỉ có fixture `claude --help`/`--version`; chưa có output stream-json hay Codex; đã có bảng `agents` lưu capabilities) Fixture output thật → `tests/contracts/fixtures`; cập nhật ASSUMPTIONS; lưu `agents.capabilities`
- [~] B4. Lỗi CLI báo rõ, không crash — xong: chưa cài, shim, exit ≠ 0, timeout, spawn lỗi, version không đọc được. CHƯA làm: "sai version" (chưa có version tối thiểu được kiểm chứng) và JSON hỏng (thuộc adapter, Sprint C)

### Sprint C — Adapter

- [ ] C1. Contract test suite dùng chung
- [ ] C2. `adapter-claude` (stream-json → AgentEvent, session map, cancel, error mapping)
- [ ] C3. `adapter-codex` (app-server, fallback exec, approval, cancel)
- [ ] C4. Side effect không xác minh được → `needs_reconciliation`

### Sprint D — IPC và UI

- [ ] D1. IPC: agents.detect/list/capabilities, projects.create, workflows.create/start, tasks.cancel, logs.query
- [ ] D2. Event stream tới UI (Tauri event channel) + backpressure
- [ ] D3. UI: Projects, Agents, New Task, Output stream, Cancel
- [ ] D4. Crash detection khi khởi động → `needs_reconciliation`

### Sprint E — Đóng phase

- [ ] E1. Đo baseline → `docs/PERF_BUDGET.md`
- [ ] E2. Kiểm tra trên Windows vật lý với bản release (ghi hash commit)
- [ ] E3. `pnpm lint && typecheck && test && build` và CI xanh
- [ ] E4. `docs/PHASE1_REPORT.md`

## Phase 2 — Multi-Agent

- [ ] Outbox/inbox + delivery ledger + migration
- [ ] Router: sequence per task, ack, dedupe, retry backoff+jitter, dead-letter, backpressure
- [ ] Transaction: state change + outbox atomic (test crash giữa chừng)
- [ ] Task DAG: cycle detection, ready-set, priority, lease/heartbeat
- [ ] Scheduler giới hạn concurrency (mặc định 2, cấu hình)
- [ ] `git-worktrees`: create/remove/list, branch naming, dirty check, conflict detect, cleanup khi hủy
- [ ] Workflow engine: Supervisor, Peer Review, Parallel Workers
- [ ] Message types: task._, review._, approval.request, agent.message
- [ ] Workflow mẫu Claude implement → Codex review (e2e thật)
- [ ] Artifact registry (hash) + Diff Viewer
- [ ] Approval Center (`approvals.resolve`), expiry
- [ ] Message Timeline + Task Board UI
- [ ] Tests: kill giữa chừng, duplicate delivery, 2 agent song song
- [ ] PHASE2_REPORT.md → **gắn tag MVP**

## Phase 3 — Gemini & Local AI

- [ ] Probe Gemini CLI (headless, `stream-json`)
- [ ] `adapter-gemini` + fixtures + contract tests
- [ ] `adapter-ollama`: HTTP client, discover models, stream
- [ ] Tool loop riêng cho Ollama (whitelist tool, read-only mặc định, giới hạn vòng lặp)
- [ ] Capability-based router
- [ ] Resource monitor (RAM/VRAM) + Resource-Aware Scheduler
- [ ] UI hiển thị capability thiếu
- [ ] Test thêm adapter giả không sửa core
- [ ] PHASE3_REPORT.md

## Phase 4 — Security & Reliability

- [ ] Policy engine: 4 mức quyền, path scope, command policy, network policy
- [ ] Canonical path validation + test traversal/symlink/junction (Windows)
- [ ] Env var allowlist, executable allowlist theo adapter
- [ ] Windows Job Object giới hạn process tree/RAM
- [ ] Spike AppContainer / Windows Sandbox (chỉ đánh giá, không cam kết 1.0) — ghi kết quả, kể cả hạn chế vào SECURITY.md
- [ ] Credential Manager cho secrets; redaction test toàn hệ thống
- [ ] Siết Tauri capabilities; nếu có localhost WS: token + Origin check + test
- [ ] Recovery 5 bước + UI resume/retry/abandon
- [ ] Log rotation, retention, diagnostics export (redacted)
- [ ] Security tests: prompt injection, output độc hại, path escape
- [ ] Soak test 100 workflow
- [ ] `pnpm audit` + rà dependency; SECURITY.md cập nhật threat model
- [ ] PHASE4_REPORT.md

## Phase 5 — Desktop Beta

- [ ] Project Workspace, Multi-Agent Chat, Task Board, Live Terminal (node-pty), Approval Center, Diff Viewer, Settings
- [ ] Phân biệt verified / agent-reported / estimated progress
- [ ] First-run wizard (detect CLI, hướng dẫn đăng nhập)
- [ ] Playwright e2e
- [ ] Installer Windows; test fresh install / upgrade / uninstall
- [ ] Beta test ≥ 3 dự án thật; ghi feedback
- [ ] PHASE5_REPORT.md

## Phase 6 — Production 1.0

- [ ] Code signing + auto-update có xác minh chữ ký
- [ ] Release pipeline + changelog + versioning
- [ ] Compatibility matrix CLI + contract tests định kỳ
- [ ] `mcp-gateway` (mức tối thiểu)
- [ ] Tài liệu vận hành: cài đặt, troubleshooting, backup/restore, threat model
- [ ] Chạy lại toàn bộ Production acceptance criteria
- [ ] PHASE6_REPORT.md, tag 1.0

## Việc xuyên suốt

- [ ] Mỗi nguồn repo công khai đã tham khảo → ghi `docs/REFERENCES.md` (URL, SHA, license, mục đích)
- [ ] Cập nhật `docs/ASSUMPTIONS.md` mỗi khi phát hiện CLI khác giả định
- [ ] Review chéo: Codex review code do Claude viết (theo phân công trong thiết kế)

## Quyết định đã chốt (chi tiết: `docs/DECISIONS.md`)

- Orchestrator chạy như Tauri sidecar, đóng gói sẵn Node runtime (ADR-001, cần spike Phase 0).
- Cô lập 1.0 = Job Object + policy engine + allowlist + sandbox của provider; AppContainer/Windows Sandbox chỉ đánh giá (ADR-002).
- A2A gateway làm sau 1.0 (ADR-003).

## Sau 1.0 (v1.1)

- [ ] A2A gateway + compatibility tests đúng phiên bản spec
- [ ] Nếu spike khả thi: cô lập AppContainer / Windows Sandbox
