# TODO — Agent Studio

Đánh dấu `[x]` khi xong **và đã kiểm chứng**. Ngữ cảnh/acceptance: `docs/ROADMAP.md`.

## Trạng thái hiện tại (cập nhật 2026-11-02, commit `63d7ef5`)

- **Phase 0: PASS (có hạn chế)** — `docs/PHASE0_REPORT.md`.
- **Phase 1: ĐÓNG (có ba ngoại lệ)** — `docs/PHASE1_REPORT.md`. CI xanh 5/5 job ở run `41551598060`; `pnpm test` 168 test pass; `cargo test` 7/7, clippy sạch. Claude 2.1.314 và Codex 0.165.0 đã chạy task thật và hủy được khi tool đang chạy (cả qua adapter lẫn nút Cancel trong app Tauri release), không để lại tiến trình mồ côi.
- **Phase 2: ĐANG LÀM** — lát 1 (outbox/inbox + Router lõi) và lát 2 (Task DAG + Scheduler), lát 3 (git-worktrees), lát 4 (nối Scheduler + worktree vào Orchestrator qua `TaskRunner`), lát 5 (WorkflowEngine: vai, Peer Review, Parallel Workers) xong, còn lại xem mục Phase 2. Thứ tự đã chốt: 2 → 7 → 8 → 9 (10 song song 5–6).
- Chưa có PR; nhánh làm việc `claude/loving-lovelace-32lh71`.

### Ngoại lệ chuyển từ Phase 1

- [ ] "Sai version" — cần ma trận tương thích (Phase 6).
- [ ] Bản release trên máy thứ hai; installer (Phase 5).
- [ ] Tool ghi/phê duyệt của CLI thật; Claude `--include-partial-messages`; Codex `turn.failed`, resume, `app-server` + approval, ép read-only (Phase 2/4; xem ASSUMPTIONS).

### Nợ kỹ thuật còn mở (không chặn phase nào đã đóng)

- [ ] `tasks.list` — session chỉ nằm trong bộ nhớ, mất khi mở lại app (Phase 7).
- [ ] UI phê duyệt (Phase 2 cơ bản, Phase 7 đầy đủ).
- [ ] Policy cho `projects.rootPath` (Phase 4/7); test nhánh lỗi của `JobObject::spawn`.
- [ ] Nút Browse… (plugin dialog, quyền `dialog:allow-open`), Settings, theme, bố cục hẹp (< 800 px) chưa kiểm trong app Tauri thật.
- [ ] `cargo audit` cho plugin dialog; ẩn adapter `stub` ngoài chế độ dev.
- [ ] Hai cảnh báo `pnpm audit` mức moderate và hai cảnh báo `cargo audit` (từ Phase 0).
- [ ] Độ ổn định test Rust trên runner CI: đã nới timeout; nếu job Tauri đỏ lại thì điều tra nguyên nhân, không nới tiếp.
- [x] Project lạ `spike-NNNN` (nguyên nhân: `SidecarService` tạo mỗi lần khởi động; nay tạo lười trong `runStub`, có test).

### Việc làm ngoài ROADMAP (theo yêu cầu người dùng)

- Làm lại UI: theme sáng/tối, sidebar kiểu Claude Code (Projects, Search, tab Agent/Multi-agent, "…" ẩn session), trang Settings + biệt danh hiển thị (mặc định "Admin", không có quyền hạn), bố cục 3 cột, Inspector thu gọn (Context/Activity/Tools/Logs), composer "task trước", trạng thái rỗng 3 bước, thẻ lỗi có hành động. Phần lấn sang Phase 5/7 về hình thức; chỉ là giao diện trên backend sẵn có.
- Mode "Multi-agent" hiện = cùng mục tiêu gửi cho ≥ 2 agent, chạy độc lập, **không điều phối** (điều phối thật: Phase 2/9).
- Cố ý không giả lập vì backend chưa có: danh sách file thay đổi, tab Plan/Files, nhánh git, "Diagnose", sửa đường dẫn project, command palette, remote agent, terminal thật (`node-pty` chưa spike, Phase 5). Ô Logs chỉ là khung xem tool_call/tool_result chỉ đọc.

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

## Phase 1 — Single-Agent MVP (ĐÓNG 2026-11-02, có ba ngoại lệ; xem `docs/PHASE1_REPORT.md`)

Điều kiện cần quyết định trước: CLI nào đã cài/đăng nhập trên Legion; chi phí test thật (ưu tiên fixture); Job Object ở Rust hay `taskkill /T` (ADR-004).

### Sprint A — Nền tảng chạy process (không cần CLI thật)

- [x] A1. Process Manager (`spawn`, `shell:false`, stream, timeout, cancel, resolve shim Windows)
- [x] A2. Spike Job Object / kill tree + test không orphan → ADR-004
- [x] A3. Task state machine + transition guard + test
- [x] A4. Migration: sessions, execution_runs, artifacts, approvals
- [x] A5. Log sink cho stderr của sidecar (hiện `Stdio::null()`)

### Sprint B — Phát hiện CLI và probe

- [x] B1. Detection + probe Claude Code — `packages/cli-probe`; fixture thật `claude` 2.1.316 (Linux) và 2.1.314 (Windows, Legion)
- [x] B2. Detection + probe Codex — fixture thật `codex-cli 0.165.0`; npm shim `codex.cmd` map sang `node <npm>/@openai/codex/bin/codex.js` (`unwrapNpmShim`, shell:false); event JSONL đã quan sát qua hai luồng thật
- [x] B3. Fixture output thật → `tests/contracts/fixtures`; ASSUMPTIONS cập nhật; `agents.capabilities` lưu trong DB (các dạng event chưa quan sát được ghi trong ASSUMPTIONS)
- [x] B4. Lỗi CLI báo rõ, không crash — chưa cài, shim, exit ≠ 0, timeout, spawn lỗi, version không đọc được, JSON hỏng (adapter nêu số dòng không hợp lệ). Ngoại lệ: "sai version" (chưa có version tối thiểu được kiểm chứng → Phase 6)

### Sprint C — Adapter

- [x] C1. Contract test suite dùng chung — `tests/contract/adapter-contract.ts` (suite) + validators `validateEventStream`/`validateCapabilities` trong `agent-core`. Mới chạy với StubAdapter; adapter claude/codex (C2/C3) phải gọi `describeAdapterContract`.
- [x] C2. `adapter-claude` — parser stream-json, prompt qua stdin, `--safe-mode` mặc định, cancel kill-tree; qua contract suite + fixture thật; đã chạy task thật và hủy giữa chừng (tool Bash) với Claude 2.1.314. CHƯA: partial messages, tool ghi/phê duyệt (Phase 2/4)
- [x] C3. `adapter-codex` — `codex exec --json -s read-only -`, shell:false qua `unwrapNpmShim`, cancel kill-tree; qua contract suite + fixture thật; đã chạy task thật và hủy giữa chừng với Codex 0.165.0. CHƯA: `turn.failed` thật, resume, `app-server`, approval (Phase 2/4)
- [x] C4. Side effect không xác minh được → `needs_reconciliation` — `classifyOutcome` + `Orchestrator.resolveReconciliation`. Quy tắc: số `tool_call` > số `tool_result` (kể cả khi bị hủy) → `needs_reconciliation`; không tự chạy lại, chỉ `requeue` tường minh mới tăng `attempt`. Giới hạn: không phân biệt tool chỉ-đọc/ghi; phụ thuộc adapter báo `tool_call` trung thực; chưa kiểm với CLI thật.

### Sprint D — IPC và UI

- [x] D1. IPC sidecar + cầu nối Tauri (allowlist `sidecar_call`): agents.detect/list/capabilities, projects.create/list, workflows.create/start, tasks.cancel, logs.query; `cwd` lấy từ project root, UI không gửi. Chưa có `tasks.list` (nợ)
- [x] D2. Event stream tới UI + backpressure — `task.message`/`task.state` trên stdout, bỏ `task.message` khi stdout > 1 MiB (client bù bằng `logs.query`); đã chạy trong app Tauri release với sidecar đóng gói
- [x] D3. UI: Projects, Agents, New Task, Output stream, Cancel — đã chạy trong app Tauri thật (task Claude/Codex thật + Cancel qua WebView2). Nợ: Browse…/Settings/theme/bố cục hẹp chưa kiểm trong app thật, `tasks.list`, UI phê duyệt, shadcn/Tailwind (đang dùng CSS thuần)
- [x] D4. Crash detection khi khởi động → `needs_reconciliation` — `Repo.recoverInterruptedTasks()`, không tự chạy lại; kiểm trong app thật (hủy khi có tool_call chưa có tool_result → `needs_reconciliation`). UI giải quyết reconciliation: Phase 2/7

### Sprint E — Đóng phase

- [x] E1. Đo baseline → `docs/PERF_BUDGET.md` (`scripts/perf-baseline.mjs`; một máy, chưa ép trong CI)
- [~] E2. Bản release Windows: `tauri build --no-bundle` + selftest 5/5 pass (cần `AGENT_STUDIO_SIDECAR_DIR` hoặc thư mục `sidecar` cạnh exe; chưa có installer). Chưa kiểm trên máy thứ hai (ngoại lệ → Phase 5)
- [x] E3. lint/format/typecheck/test (168)/build/cargo test (7)/clippy pass; CI xanh 5/5 ở run `41551598060` (commit `63d7ef5`)
- [x] E4. `docs/PHASE1_REPORT.md` — kết luận: Phase 1 ĐÓNG (2026-11-02) có ba ngoại lệ

## Phase 2 — Multi-Agent

- [x] Outbox/inbox + delivery ledger + migration (`0003_outbox_inbox`; test mở lại DB vẫn còn delivery)
- [~] Router: sequence per task, ack, dedupe, retry backoff+jitter, dead-letter, backpressure — `services/orchestrator/src/router.ts` có test (ack = markDelivered, dedupe theo message id qua inbox, batchSize). CHƯA: dedupe theo `correlationId`, vòng lặp tick nền, nối vào Orchestrator/sidecar
- [~] Transaction: message + outbox atomic (`appendMessageWithOutbox`, test rollback). CHƯA: đổi state task + outbox cùng transaction; test kill process thật
- [x] Task DAG: cycle detection (kể cả gián tiếp), ready-set, priority, lease/heartbeat — `Repo.addDependency/claimNextReady/heartbeat/expireLeases/listBlockedTasks`; lease hết hạn → `needs_reconciliation`, không tự retry
- [~] Scheduler giới hạn concurrency (mặc định 2, cấu hình) — `services/orchestrator/src/scheduler.ts` (tick: hết hạn lease → lấp slot → báo blocked). Đã nối: `TaskRunner` (submit/pump/cancel) chạy task đã claim + heartbeat. CHƯA: nối vào sidecar/UI (`workflows.start` vẫn dùng `runTask` cũ), tick nền, slot theo agent/worktree
- [x] `git-worktrees`: create/remove/list, branch naming (`agent/<taskId>`, id được whitelist), dirty check, conflict detect (`merge-tree --write-tree`, không đụng working tree), cleanup (từ chối khi dirty trừ `force`; giữ branch trừ `deleteBranch`) — `packages/git-worktrees`, test với git thật; bảng `worktrees` (`0004`). Đã nối qua `TaskRunner` (tạo khi claim, huỷ+sạch → xoá, huỷ+dirty → giữ). CHƯA: dọn worktree task completed/failed, merge/đưa kết quả về nhánh chính, nối vào sidecar
- [~] Workflow engine: Peer Review (implement → checkpoint commit → review trên nhánh của implementer, verdict `VERDICT:` agent-reported) và Parallel Workers (worktree riêng + phát hiện conflict từng cặp) — `services/orchestrator/src/workflow-engine.ts`, test bằng adapter giả có ghi file. CHƯA: Supervisor (cần agent phân rã kế hoạch), nối sidecar/UI, gate e2e bằng CLI thật (adapter hiện chỉ read-only, cần ghi + approval ở Phase 4)
- [~] Message types: `review.request`/`review.result` đã ghi vào luồng task khi handoff (append thường, chưa qua outbox). CHƯA: approval.request, agent.message
- [~] Vai (role): `RoleDef` (hướng dẫn, `access` khai báo, agent cho phép), gán theo từng lượt chạy, từ chối gán sai (`roles.ts`). CHƯA: `access` chưa được ép theo task — adapter cố định sandbox lúc tạo (hiện cả hai read-only); ép quyền thật cần Phase 4
- [~] Bảng ngữ cảnh chung tối thiểu: bảng `context_entries` (goal/plan/decision/artifact + `report`), nguồn từng mục (`user`/`verified`/`agent-reported`), artifact có path + sha256 do engine tự băm từ worktree, lọc theo `RoleDef.sees` (`context-board.ts`); test: reviewer chỉ nhận goal/artifact/report cuối, không nhận log thô; plan chỉ hiện cho vai có `sees` plan. CHƯA: ai ghi `plan`/`decision` (cần Supervisor), tóm tắt có nguồn, nhật ký sửa/xóa, đo chi phí token
- [ ] Workflow mẫu Claude implement → Codex review (e2e thật) — engine sẵn sàng và đã kiểm bằng adapter giả; e2e thật bị chặn bởi: adapter chưa có chế độ ghi + approval
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

## Phase 7 — Ngang AionUi về trải nghiệm cốt lõi (sau Phase 2)

- [ ] `tasks.list` + lịch sử task, lọc, tìm kiếm log
- [ ] Hộp thoại chọn thư mục qua backend
- [ ] Settings → Agents (command/args/env, probe, secrets vào Credential Manager)
- [ ] Approval UI đầy đủ (một lần / trong phạm vi / từ chối) + nhật ký quyết định
- [ ] Tailwind/shadcn, dark/light, phím tắt
- [ ] Preset "assistant" cục bộ, export/import
- [ ] E2E "cài đặt → project → task thật" không đụng terminal
- [ ] Policy cho `projects.rootPath`
- [ ] PHASE7_REPORT.md

## Phase 8 — Mở rộng agent: ACP, MCP, Skills

- [ ] Probe + contract test ACP với ≥ 2 agent thật; ghi ASSUMPTIONS
- [ ] Permission ACP đi qua Policy Engine + Approval UI
- [ ] Quản lý MCP server theo project (bật/tắt tool, hiển thị quyền)
- [ ] Skills/prompt packs: nguồn + hash, mặc định chỉ đọc
- [ ] Process registry (PID + thời điểm tạo) để dọn mồ côi an toàn
- [ ] Hạn mức khởi tạo theo CLI/ACP
- [ ] PHASE8_REPORT.md

## Phase 9 — Multi-agent có cấu trúc

- [ ] 3 workflow mẫu (implement → review → fix; song song trên worktree; kiểm tra chéo), export/import
- [ ] Handoff mang bằng chứng (diff, test, hash)
- [ ] UI Multi-agent theo đội: chọn mẫu, gán agent vào vai, xem kế hoạch/tiến độ (thay chế độ "cùng mục tiêu, độc lập" hiện tại)
- [ ] Ngữ cảnh chung có kiểm soát: giới hạn cỡ, tóm tắt có nguồn, hiển thị phần mỗi agent nhận, nhật ký sửa/xóa
- [x] Quyết định thứ tự (2026-11-02): giữ Phase 2 → 7 → 8 → 9, không đẩy "đội/vai/ngữ cảnh" lên trước Phase 7–8
- [ ] Bảng verified / agent-reported / estimated trên mọi màn hình trạng thái
- [ ] Lịch chạy có giới hạn, qua policy
- [ ] Gộp worktree an toàn, xem trước xung đột
- [ ] PHASE9_REPORT.md

## Phase 10 — Nhẹ, nhanh, hoàn thiện

- [ ] Ngân sách hiệu năng trong CI (khởi động, RAM, kích thước installer, độ trễ event)
- [ ] Diagnostics một nút, đã redact
- [ ] ADR đánh giá Remote/WebUI và làm việc nhóm
- [ ] PHASE10_REPORT.md

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
