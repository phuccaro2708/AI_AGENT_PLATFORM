# ROADMAP — Agent Studio

Ước lượng cho 1 developer có AI hỗ trợ; không phải cam kết. Mỗi phase chỉ đóng khi đạt **Acceptance gate**. Chi tiết việc cần làm: `docs/TODO.md`.

Nguyên tắc ưu tiên: **Agent Runtime → Message Router → Durable Task State → Permission Engine** trước, UI và số lượng LLM sau.

## Tổng quan

| Phase | Tên                    | Thời gian | Kết quả chính                                                                                |
| ----- | ---------------------- | --------- | -------------------------------------------------------------------------------------------- |
| 0     | Foundation             | 3–5 ngày  | Monorepo, Tauri shell, SQLite+migrations, contracts, stub adapter, logging, CI               |
| 1     | Single-Agent MVP       | 1–2 tuần  | Claude + Codex chạy task độc lập, streaming, cancel, session mapping                         |
| 2     | Multi-Agent            | 1–2 tuần  | Message router, task DAG, supervisor, QA handoff, worktrees → **MVP có giá trị**             |
| 3     | Gemini & Local AI      | 1–2 tuần  | Gemini CLI, Ollama + tool loop, capability routing, resource-aware scheduler                 |
| 4     | Security & Reliability | 2–3 tuần  | Policy engine, sandbox tests, recovery, observability                                        |
| 5     | Desktop Beta           | 1–2 tuần  | UI hoàn chỉnh, settings, installer Windows, beta test                                        |
| 6     | Production 1.0         | 2–4 tuần  | Release engineering, update có chữ ký, MCP gateway tối thiểu, tài liệu vận hành (A2A → v1.1) |

Tổng ≈ 9–18 tuần.

## Phase 0 — Foundation (3–5 ngày)

**Mục tiêu:** nền tảng build/test được, contracts khóa trước khi viết logic.

- pnpm monorepo theo cấu trúc: `apps/desktop`, `services/orchestrator`, `packages/*`, `tests/*`, `docs/`.
- Tauri 2 + React + Vite khởi chạy được.
- Spike sidecar: đóng gói Node + native modules vào Tauri sidecar trên Windows (ADR-001).
- `packages/contracts` (Zod): AgentMessage, AgentEvent, AgentTask, AgentCapability, state enums.
- `packages/storage`: SQLite WAL + Drizzle + migrations (projects, workflows, tasks, task_dependencies, messages, events, settings).
- `packages/agent-core`: interface `AgentAdapter` + `StubAdapter` xác định (deterministic).
- Logging Pino có redaction (key, token, authorization, env secrets).
- ESLint, Prettier, `tsc --noEmit`, Vitest, GitHub Actions CI (windows-latest + ubuntu).
- Docs: ARCHITECTURE, PROTOCOL, DATABASE, SECURITY, ASSUMPTIONS, REFERENCES, PHASE0_REPORT.

**Acceptance gate**

- [ ] Desktop app mở được.
- [ ] Migrations chạy từ DB rỗng và idempotent.
- [ ] Stub agent phát chuỗi AgentEvent đã validate bằng Zod.
- [ ] `lint`, `typecheck`, `test`, `build` pass trên CI.
- [ ] Không có secrets/đường dẫn cá nhân trong repo (secret scan sạch).
- [ ] Mọi giả định chưa kiểm chứng được ghi trong ASSUMPTIONS.md.
- [ ] Spike sidecar có kết quả ghi trong ADR-001 (thành công hoặc phương án thay thế).

## Phase 1 — Single-Agent MVP (1–2 tuần)

- Process Manager: spawn `shell:false`, resolve shim `.cmd`/`.exe` trên Windows, stream stdout/stderr, timeout, cancel (kill process tree qua Job Object / `taskkill /T`).
- CLI detection + **compatibility probe** (version, flags thực tế) cho Claude Code và Codex; lưu kết quả vào `agents.capabilities`.
- `ClaudeAdapter`: headless CLI/Agent SDK, parse `stream-json`, session mapping (`sessions.native_session_id`), resume nếu probe xác nhận.
- `CodexAdapter`: ưu tiên `codex app-server` (session, streaming, approval); fallback `codex exec --json`.
- Execution runs (pid, exit_code) + logs; task state machine (queued → running → waiting_approval → completed/failed/cancelled).
- Tauri IPC commands: `system.health`, `agents.detect/list/capabilities`, `projects.create`, `workflows.create/start`, `tasks.cancel`, `events.subscribe`, `logs.query`.
- UI cơ bản: Projects, Agent list, tạo task, output streaming, nút Cancel.
- Phát hiện crash: task `running` sau restart → `needs_reconciliation`.
- Đo baseline: startup time, RAM, event latency → chốt performance budget.

**Acceptance gate**

- [ ] Claude và Codex mỗi bên chạy được 1 task thật độc lập.
- [ ] Cancel dừng cả process tree (test không còn orphan).
- [ ] Lỗi CLI (không cài, sai version, exit ≠ 0, JSON hỏng) được báo rõ, không crash.
- [ ] Contract tests với fixture output thật đã ghi lại của từng CLI.

## Phase 2 — Multi-Agent Collaboration (1–2 tuần) → MVP

- Durable Message Router: outbox/inbox, sequence per task, ack, dedupe theo `id`/`correlationId`, retry backoff + jitter, dead-letter, backpressure.
- Transaction ghi state + outbox cùng lúc.
- Task DAG + scheduler (priority, dependency, lease, giới hạn concurrency mặc định 2).
- `packages/git-worktrees`: tạo/dọn worktree theo task, branch naming, phát hiện conflict, bảng `worktrees`.
- Workflow engine: Supervisor + Peer Review + Parallel Workers.
- Handoff mẫu: Claude implement → Codex review (`review.request` / `review.result`).
- Artifact registry (path + hash), diff viewer, message timeline.
- Approval Center cơ bản (`approvals.resolve`).

**Acceptance gate**

- [ ] Workflow thật "implement → review" chạy không cần copy tay giữa terminal.
- [ ] Kill app giữa chừng → restart không mất message đã commit; duplicate được xử lý an toàn.
- [ ] 2 agent song song trên 2 worktree không ghi đè nhau.
- [ ] Task side-effect không rõ → `needs_reconciliation`, không auto-retry.

## Phase 3 — Gemini & Local AI (1–2 tuần)

- `GeminiAdapter`: headless + `--output-format stream-json`, parse JSONL (init/message/tool_use/tool_result/error/result), theo probe thực tế.
- `OllamaAdapter`: HTTP API streaming, discover models, tool-calling loop riêng với tool whitelist; mặc định read-only.
- Capability-based routing (không hard-code theo tên agent).
- Resource-Aware Scheduler: theo dõi RAM/VRAM, 1 model Ollama tại một thời điểm, tạm ngừng nhận local inference khi thiếu tài nguyên.
- UI hiển thị rõ khả năng agent không hỗ trợ (resume/approval…) thay vì giả lập.

**Acceptance gate**

- [ ] 4 adapter qua cùng bộ contract test.
- [ ] Thêm adapter mới không sửa Orchestrator core.
- [ ] Hết VRAM/RAM → hệ thống degrade có kiểm soát, không treo máy.

## Phase 4 — Security & Reliability (2–3 tuần)

- Policy Engine: path scope (canonical path, chống traversal/symlink escape), command policy, network policy, 4 mức quyền (Read Only / Workspace Write / Restricted Tools / Privileged).
- Cô lập: Job Objects (giới hạn process tree/RAM), whitelist env var, executable allowlist; spike đánh giá AppContainer/Windows Sandbox (không cam kết 1.0, ADR-002) — ghi rõ phần chưa đạt.
- Secrets qua Windows Credential Manager; redaction test.
- Tauri capabilities tối thiểu; nếu cần localhost WebSocket: token phiên ngắn + kiểm tra Origin.
- Recovery đầy đủ theo quy trình 5 bước; UI chọn resume / retry an toàn / bỏ.
- Observability: log rotation, metrics nội bộ, trace theo correlationId, export diagnostics (đã redact).
- Security tests: path escape, injection qua prompt/tên file, agent output độc hại, prompt-injection từ nội dung repo.
- Soak test: 100 workflow liên tục.

**Acceptance gate**

- [ ] Không sửa đổi ngoài phạm vi được cấp trong sandbox tests.
- [ ] 100 workflow không mất state.
- [ ] Không còn lỗ hổng Critical/High chưa xử lý.

## Phase 5 — Desktop Beta (1–2 tuần)

- Hoàn thiện: Project Workspace, Multi-Agent Chat, Task Board, Live Terminal (node-pty, chỉ interactive), Approval Center, Diff Viewer, Settings.
- Phân biệt verified state / agent-reported / estimated progress.
- Installer Windows (Tauri bundler), first-run wizard (detect CLI, hướng dẫn đăng nhập).
- E2E Playwright; beta test với ≥ 3 dự án thật; thu feedback.

**Acceptance gate**

- [ ] Approval, cancel, retry, diff, logs nhất quán.
- [ ] Fresh install / upgrade / uninstall pass smoke test.

## Phase 6 — Production 1.0 (2–4 tuần)

- Code signing, auto-update có xác minh chữ ký, release pipeline, changelog.
- Compatibility matrix phiên bản CLI được hỗ trợ + CI chạy contract tests định kỳ.
- MCP gateway tối thiểu (`packages/mcp-gateway`). A2A gateway **để sau 1.0 (v1.1)** — chỉ gọi "A2A-compatible" sau khi qua compatibility tests đúng phiên bản spec (ADR-003).
- Tài liệu vận hành: cài đặt, troubleshooting, backup/restore DB, threat model.

**Acceptance gate:** toàn bộ bảng Production acceptance trong thiết kế (persistence, delivery, CLI compat, cancellation, recovery, source safety, reliability, security, packaging, UI).

## Rủi ro chính

| Rủi ro                                          | Giảm thiểu                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| CLI đổi flag/format giữa các phiên bản          | Compatibility probe + fixture contract tests + pin phiên bản hỗ trợ |
| Agent ghi file ngoài phạm vi                    | Policy engine + Job Object; không dựa vào worktree làm sandbox      |
| Retry gây side effect trùng                     | `needs_reconciliation`, idempotent handler                          |
| Orphan process trên Windows                     | Job Objects, test cancel                                            |
| Hết RAM/VRAM (16 GB / 8 GB)                     | Resource-aware scheduler, concurrency mặc định 2                    |
| Phụ thuộc/nội dung repo công khai không an toàn | Chính sách trong `CLAUDE.md`, ghi `docs/REFERENCES.md`              |
| Scope creep (thêm nhiều LLM, UI sớm)            | Chỉ đóng phase khi đạt gate                                         |
