# TODO — Agent Studio

Đánh dấu `[x]` khi xong **và đã kiểm chứng**. Ngữ cảnh/acceptance: `docs/ROADMAP.md`.

## Phase 0 — Foundation

### Repo & tooling

- [ ] `pnpm-workspace.yaml`, `package.json` gốc, `.nvmrc`/engines (Node LTS), `.gitignore`, `.editorconfig`
- [ ] ESLint + Prettier + `tsconfig.base.json` (strict)
- [ ] Vitest cấu hình dùng chung
- [ ] Scripts gốc: `lint`, `typecheck`, `test`, `build`
- [ ] GitHub Actions: lint/typecheck/test/build (ubuntu + windows)
- [ ] Secret scan trong CI (vd. gitleaks — kiểm tra license/version trước khi dùng)
- [ ] `README.md` (cách chạy, yêu cầu: Node, pnpm, Rust, WebView2)

### Packages

- [ ] `packages/contracts`: Zod schema cho AgentMessage, AgentEvent, AgentTask, AgentCapability, WorkflowState, TaskState
- [ ] `packages/shared-utils`: id (ULID), clock, result type, redact helper
- [ ] `packages/agent-core`: `AgentAdapter` interface + registry + `StubAdapter`
- [ ] `packages/storage`: Drizzle schema, migrations, WAL pragma, repo layer, test DB in-memory
- [ ] Bảng Phase 0: projects, workflows, tasks, task_dependencies, messages, events, settings
- [ ] Logging Pino + redaction + test redaction

### Apps/services

- [ ] `apps/desktop`: Vite + React + Tailwind + shadcn, màn hình health
- [ ] `apps/desktop/src-tauri`: shell Tauri 2, capabilities tối thiểu, command `system.health`
- [ ] `services/orchestrator`: skeleton (entry, config, health), chạy StubAdapter end-to-end
- [ ] Spike sidecar: đóng gói Node + `better-sqlite3` + `node-pty` vào Tauri sidecar trên Windows; ghi kết quả vào ADR-001

### Docs

- [ ] ARCHITECTURE.md, PROTOCOL.md, DATABASE.md, SECURITY.md
- [ ] ASSUMPTIONS.md (giả định chưa kiểm chứng), REFERENCES.md (nguồn tham khảo)
- [ ] PHASE0_REPORT.md (lệnh đã chạy, kết quả, vấn đề tồn đọng)

## Phase 1 — Single-Agent MVP

- [ ] Process Manager (`spawn`, `shell:false`, stream, timeout, kill tree, Windows shim resolve)
- [ ] Job Object / tree-kill ở lớp Rust hoặc Node (chọn + ADR), test orphan
- [ ] Task state machine + transition guard + test
- [ ] Bảng sessions, execution_runs, artifacts, approvals
- [ ] CLI detection + probe: Claude Code (version, flags)
- [ ] CLI detection + probe: Codex (version, `app-server`, `exec --json`)
- [ ] Ghi fixture output thật của từng CLI vào `tests/contracts/fixtures`
- [ ] `adapter-claude`: parse stream-json → AgentEvent; session map; cancel; error mapping
- [ ] `adapter-codex`: app-server client; fallback exec; approval event; cancel
- [ ] Contract test suite dùng chung cho mọi adapter
- [ ] IPC commands: agents.detect/list/capabilities, projects.create, workflows.create/start, tasks.cancel, logs.query
- [ ] Event stream tới UI (Tauri event channel); backpressure
- [ ] UI: Projects, Agents, New Task, Output stream, Cancel
- [ ] Crash detection khi khởi động → `needs_reconciliation`
- [ ] Đo baseline (startup, RAM, latency) → `docs/PERF_BUDGET.md`
- [ ] PHASE1_REPORT.md

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
