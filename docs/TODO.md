# TODO — Agent Workspace

Đánh dấu `[x]` khi xong **và đã kiểm chứng**. Ngữ cảnh/acceptance: `docs/ROADMAP.md`.

## Trạng thái hiện tại (cập nhật 2026-11-02, commit `63d7ef5`)

- **Phase 0: PASS (có hạn chế)** — `docs/PHASE0_REPORT.md`.
- **Phase 1: ĐÓNG (có ba ngoại lệ)** — `docs/PHASE1_REPORT.md`. CI xanh 5/5 job ở run `41551598060`; `pnpm test` 168 test pass; `cargo test` 7/7, clippy sạch. Claude 2.1.314 và Codex 0.165.0 đã chạy task thật và hủy được khi tool đang chạy (cả qua adapter lẫn nút Cancel trong app Tauri release), không để lại tiến trình mồ côi.
- **Phase 2: đóng 2026-11-03 (có ngoại lệ, xem PHASE2_REPORT).** Tiếp theo: 7 → 8 → 9 (10 song song 5–6).
- Cập nhật 2026-11-04: nhánh gốc `claude/loving-lovelace-32lh71` đã ở `868daef` (gồm 7A, 7B, quét CLI, redaction, bỏ Gemini); PR #1 đã MERGED. Kiểm cục bộ: lint, typecheck, 383 test, build đều qua; `cargo clippy -D warnings` sạch, `cargo test` 12 qua / 1 bỏ qua. CI `babca05` đỏ vì Prettier lệch ở `docs/HANDOFF.md`; `868daef` (đã format lại) xanh 5/5 job.
- **Thứ tự chốt lại 2026-11-04** (ROADMAP, mục "Thứ tự thực hiện"; ADR-005): Phase 7 (phần không cần policy) song song Phase 3 → Phase 4 (+ 7C-2, đóng Phase 7) → Phase 5 → Phase 6 → Phase 8 → Phase 9; Phase 10 xuyên suốt.
- Ollama: hoãn, bỏ khỏi kế hoạch hiện tại vì máy chưa cài (không có để probe). Làm lại khi có môi trường.

### Ngoại lệ chuyển từ Phase 1

- [ ] "Sai version" — cần ma trận tương thích (Phase 6).
- [ ] Bản release trên máy thứ hai; installer (Phase 5).
- [ ] Tool ghi/phê duyệt của CLI thật; Claude `--include-partial-messages`; Codex `turn.failed`, resume, `app-server` + approval, ép read-only (Phase 2/4; xem ASSUMPTIONS).

### Nợ kỹ thuật còn mở (không chặn phase nào đã đóng)

- [x] `tasks.list` — Peer Review khôi phục sau restart (id run lưu ở localStorage). Session chế độ Agent đơn vẫn chỉ nằm trong bộ nhớ (Phase 7).
- [~] UI phê duyệt: cơ bản xong (Phase 2); đầy đủ + nguồn approval thật: Phase 4/7.
- [ ] Policy cho `projects.rootPath` (Phase 4/7); test nhánh lỗi của `JobObject::spawn`.
- [ ] Nút Browse… (plugin dialog, quyền `dialog:allow-open`), Settings, theme, bố cục hẹp (< 800 px) chưa kiểm trong app Tauri thật.
- [ ] `cargo audit` cho plugin dialog; ẩn adapter `stub` ngoài chế độ dev.
- [ ] Hai cảnh báo `pnpm audit` mức moderate và hai cảnh báo `cargo audit` (từ Phase 0).
- [ ] Độ ổn định test Rust trên runner CI: đã nới timeout; nếu job Tauri đỏ lại thì điều tra nguyên nhân, không nới tiếp.
- [x] Project lạ `spike-NNNN` (nguyên nhân: `SidecarService` tạo mỗi lần khởi động; nay tạo lười trong `runStub`, có test).

### Việc làm ngoài ROADMAP (theo yêu cầu người dùng)

- Làm lại UI: theme sáng/tối, sidebar kiểu Claude Code (Projects, Search, tab Agent/Multi-agent, "…" ẩn session), trang Settings + biệt danh hiển thị (mặc định "Admin", không có quyền hạn), bố cục 3 cột, Inspector thu gọn (Context/Activity/Tools/Logs), composer "task trước", trạng thái rỗng 3 bước, thẻ lỗi có hành động. Phần lấn sang Phase 5/7 về hình thức; chỉ là giao diện trên backend sẵn có.
- Mode thứ hai của UI nay là Peer Review thật (Phase 2). Supervisor / Parallel Workers: Phase 9. Nợ Phase 2: engine resume sau restart, UI giải quyết reconciliation, chạy qua app Tauri thật.
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

## Phase 2 — Multi-Agent (đóng 2026-11-03, có ngoại lệ: docs/PHASE2_REPORT.md)

- [x] Outbox/inbox + delivery ledger + migration
- [x] Router: sequence per task, ack, dedupe, retry backoff+jitter, dead-letter, backpressure
- [x] Transaction: state change + outbox atomic (test crash giữa chừng)
- [x] Task DAG: cycle detection, ready-set, priority, lease/heartbeat (chưa có IPC `createDag`)
- [~] Scheduler giới hạn concurrency (mặc định 2; chưa đọc từ settings)
- [x] `git-worktrees`: create/remove/list, branch naming, dirty check, conflict detect, cleanup khi hủy (S4 hủy khi đang ghi với CLI thật: chưa)
- [~] Workflow engine: Peer Review xong; **Supervisor, Parallel Workers chưa làm (Phase 9)**; engine chưa resume sau restart
- [~] Message types: `task.*`, `review.*`, `approval.request` xong; `agent.message` chưa dùng
- [x] Vai (role) trong workflow: hướng dẫn, quyền, agent cho phép; gán agent vào vai theo cấu hình lượt chạy (chưa có IPC `roles.upsert`)
- [x] Bảng ngữ cảnh chung tối thiểu: lọc theo vai, có test
- [x] Workflow mẫu Claude implement → Codex review (e2e thật, `scripts/e2e-peer-review.mjs`; chưa qua UI trong app Tauri)
- [x] Artifact registry (hash) + Diff Viewer
- [~] Approval Center (`approvals.resolve`), expiry: có UI/IPC/service, **chưa có đường production tạo approval** (timer hết hạn đã có, 7C-1)
- [x] Message Timeline + Task Board UI (chưa kiểm trong app thật; poll, không có push)
- [x] Tests: kill giữa chừng (thật), duplicate delivery (fake), 2 agent song song (thật)
- [x] PHASE2_REPORT.md → tag `mvp-phase2`

Nợ chuyển tiếp từ Phase 2: engine resume sau restart + UI giải quyết reconciliation (Phase 7); Supervisor/Parallel Workers (Phase 9); đường tạo approval từ CLI thật (Phase 4); perf-baseline sau bước 3 (R11).

## Phase 3 — Quét CLI & Local AI

- [x] Quét CLI agent theo danh sách ứng viên khai báo bằng dữ liệu (PATH + vị trí cài Windows), hiển thị "đã phát hiện, chưa hỗ trợ" (`agents.scan`, `packages/cli-probe/src/candidates.ts`, Settings → Agents)
- [x] Probe Antigravity (`agy`, quan sát `--print`, `--output-format stream-json`; đã có fixture `--help` 1.4.8 + capability từ help, đã quan sát output thật 2026-11-04: 2 lượt `--print`, xem ASSUMPTIONS; adapter dựng 2026-11-04, chỉ kiểm bằng CLI giả) rồi `adapter-antigravity` + fixtures + contract tests
- [ ] `adapter-ollama`: HTTP client, discover models, stream
- [ ] Tool loop riêng cho Ollama (whitelist tool, read-only mặc định, giới hạn vòng lặp)
- [x] Capability-based router (`services/orchestrator/src/capability-router.ts`; chưa nối vào `workflows.start`)
- [ ] Resource monitor (RAM/VRAM) + Resource-Aware Scheduler
- [x] UI hiển thị capability thiếu (helper `describeCapabilityGap`) — `apps/desktop/src/capabilityGap.ts` (+ test, nối vào AgentView/PeerReviewView, chặn Run kèm lý do); đã xem trong app Tauri thật 2026-11-04 (Peer Review với `agy` thật trên máy: nhãn `(thiếu capability)`, Start review bị khoá kèm lý do; xem PROGRESS.md). Riêng nhánh AgentView (cần `streaming`) chưa chạm được vì không adapter nào thiếu `streaming`; chỉ có unit test
- [x] Test thêm adapter giả không sửa core (cho routing; xem PHASE3_REPORT về giới hạn của sidecar)
- [~] PHASE3_REPORT.md (có bản nháp trung thực; Phase 3 chưa đóng: còn Ollama, resource monitor, UI capability thiếu, adapter `agy` chưa chạy CLI thật)

## Phase 4 — Security & Reliability

- [~] Policy engine: 4 mức quyền, path scope, command policy, network policy — phần mã thuần xong 2026-11-05 (`packages/policy-engine`, 41 test trên Linux); CHƯA nối vào orchestrator/IPC/UI, chưa quan sát yêu cầu quyền thật của CLI (ASSUMPTIONS, mục Phase 4)
- [~] Canonical path validation + test traversal/symlink — đã chạy trên Linux; junction/UNC/8.3/ADS và mọi thứ trên Windows CHƯA chạy
- [ ] Env var allowlist, executable allowlist theo adapter
- [ ] Windows Job Object giới hạn process tree/RAM
- [ ] Spike AppContainer / Windows Sandbox (chỉ đánh giá, không cam kết 1.0) — ghi kết quả, kể cả hạn chế vào SECURITY.md
- [~] Credential Manager cho secrets (7B); redaction test: DB + log + IPC + sự kiện đã có test với agent giả (`sidecar-redaction.test.ts`, che theo giá trị chính xác ≥ 6 ký tự); còn thiếu diagnostics export (chưa tồn tại) và giới hạn đã ghi ở SECURITY.md
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
- [ ] `mcp-gateway` (mức tối thiểu) — làm đầu Phase 6 vì Phase 8 cần
- [ ] Tài liệu vận hành: cài đặt, troubleshooting, backup/restore, threat model
- [ ] Chạy lại toàn bộ Production acceptance criteria
- [ ] PHASE6_REPORT.md, tag 1.0

## Phase 7 — Ngang AionUi về trải nghiệm cốt lõi (sau Phase 2)

### 7A — Nợ Phase 2 + lịch sử task (code xong 2026-11-03)

- [x] `tasks.history` + `logs.search` (lọc project/agent/state, phân trang; tìm log bằng LIKE trên `payload_json`, chưa có index, chưa benchmark) — tab History trong UI
- [x] `tasks.resolveReconciliation` (quyết định tường minh + ghi chú bắt buộc; `requeue` mới tăng `attempt`)
- [x] Peer Review engine resume sau restart và sau quyết định reconciliation (`resumeAll`/`resume`); giới hạn: `maxRounds` tùy chỉnh không được lưu qua restart
- [x] UI: thẻ "Needs your decision" (diff trước, không quyết định mặc định, requeue cần xác nhận)
- [x] Kiểm với CLI thật (2026-11-04: claude→codex và codex→claude đều: kill → needs_reconciliation → requeue → workflow completed, exit 0): `node scripts/e2e-peer-review.mjs resume <impl> <rev>` (script đã viết, đã chạy 2026-11-03 với claude→codex: kill → needs_reconciliation → requeue → workflow completed; một lần thoát mã 1 chỉ do dọn thư mục tạm bị EPERM, đã sửa)
- [x] Chạy UI 7A trong app Tauri thật (2026-11-03, bản debug build từ `1009755`, WebView2 + CDP cổng 9334, DB tạm, PATH chỉ có System32 nên không CLI thật nào chạy; không dùng chuột/bàn phím người dùng). Đạt: (a) History liệt kê 9 task, lọc project/agent/state và tổ hợp đều đúng, "No tasks match." khi rỗng; (b) tìm log không phân biệt hoa/thường, `%` `_` khớp nghĩa đen, không khớp → "No log line contains that text."; (c) task `running` có lease hết hạn → sau khi mở lại app thành `needs_reconciliation`, thẻ "Needs your decision" hiện; nút Confirm bị khoá tới khi chọn + có ghi chú; cả 4 quyết định completed/failed/cancelled/requeue ghi `events` với `reason = "reconciled by user: <note>"`; requeue cần tick xác nhận, tăng `attempt` 0→1; (d) tắt/mở lại app: 9 task, 4 message, 10 event giữ nguyên, danh sách run Peer Review giữ nguyên. Giới hạn: workflow seed không có `workflow_roles` nên sau `completed` workflow chuyển `failed` (không kiểm hand-over sang reviewer ở UI); task requeue chạy xong `failed` ("task has no task.request message") vì dữ liệu seed; "kill app giữa lúc task chạy" được mô phỏng bằng seed `running` + khởi động lại, không kill tiến trình thật; ô Search im lặng với truy vấn 1 ký tự (đúng thiết kế 2+ ký tự); chưa kiểm Open log và Newer/Older ở bộ dữ liệu >1 trang

### 7B — Thư mục, settings agent, secrets (code xong 2026-11-03)

- [x] Policy cho `projects.rootPath` (tồn tại, canonical, không quá rộng, không trùng)
- [x] Hộp thoại chọn thư mục là lệnh native; webview không còn quyền dialog
- [x] Cấu hình agent theo provider (command/args/env), chỉ có hiệu lực sau probe tốt; env là allowlist
- [x] Secrets trong Windows Credential Manager, chỉ ghi từ UI, tiêm vào sidecar khi spawn theo provider
- [x] UI Settings → Agents
- [x] Chạy 7B trong app Tauri thật (2026-11-03, WebView2 + CDP, DB tạm): Browse, policy rootPath, Agents, Secrets đạt; tìm ra `node.exe` lọt probe Claude và màu hộp Check — đã sửa (`52660f3`). Đã kiểm lại màu hộp Check trong app thật ngày 2026-11-04 (xem PROGRESS)
- [x] `cargo audit` khi có công cụ (2026-11-04: 0.22.2 cục bộ, không lỗ hổng, 2 cảnh báo transitive)
- [x] CI xanh cho `52660f3` (5/5 job, 2026-11-04)
- [ ] Đọc CI của `babca05` trên nhánh gốc; chạy lại `clippy` và `cargo test` sau khi gộp quét CLI

### Còn lại của Phase 7

- [~] Approval UI đầy đủ (một lần / trong phạm vi / từ chối) + nhật ký quyết định: 7C-1 xong 2026-11-04 (thẻ chi tiết, ghi chú, nhật ký, timer hết hạn, `ApprovalScope` + `approval_grants`, nút phạm vi bị khoá); 7C-2 (cấp quyền thường trực, nguồn approval thật) chờ Policy Engine Phase 4; hợp đồng cho 7C-2 đã có (`evaluate` với `ctx.grants`, `grantTargetFor`), còn phải nối `approvals.resolve` + `approval_grants` + UI (cần sửa IPC 4 chỗ) và người dùng duyệt phạm vi grant
- [ ] Tailwind/shadcn (chưa làm: cần người dùng duyệt dependency — pin ≥ 2 tuần, audit, license, `docs/REFERENCES.md`); dark/light đã có
- [x] Phím tắt cơ bản (`shortcuts.ts`: Ctrl+1/2/H/,/Shift+N; Ctrl+Enter gửi composer) — chỉ có test Vitest, chưa kiểm trong app Tauri thật
- [x] Preset "assistant" cục bộ + export/import JSON (`presets.ts`, Settings → Presets; chỉ ghép chữ trước prompt, không cấp quyền) — chỉ có test Vitest, chưa kiểm trong app Tauri thật
- [x] Danh sách radio "What happened?" xếp thành thẻ ngang (CSS; chưa nhìn bằng mắt trong app thật)
- [ ] E2E "cài đặt → project → task thật" không đụng terminal
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
