# ROADMAP — Agent Workspace

Ước lượng cho 1 developer có AI hỗ trợ; không phải cam kết. Mỗi phase chỉ đóng khi đạt **Acceptance gate**. Chi tiết việc cần làm: `docs/TODO.md`.

Nguyên tắc ưu tiên: **Agent Runtime → Message Router → Durable Task State → Permission Engine** trước, UI và số lượng LLM sau.

## Tiến trình (cập nhật 2026-11-05)

| Phase | Trạng thái                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | **PASS (có hạn chế)** — CI xanh (runner), đã xác minh trên Windows vật lý bằng `tauri dev`; xem PHASE0_REPORT                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 1     | **ĐÓNG (2026-11-02), có ngoại lệ** — cả 4 tiêu chí đạt/đạt có giới hạn, CI xanh; ngoại lệ chuyển phase sau (sai version → Phase 6, release máy thứ hai → Phase 5, tool ghi/phê duyệt → Phase 2/4). Xem PHASE1_REPORT                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2     | **ĐÓNG (2026-11-03), có ngoại lệ** — CI xanh 5/5; xem PHASE2_REPORT                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7     | **ĐANG LÀM (từ 2026-11-03)** — 7A và 7B đã có code, test và push; kiểm trong app Tauri thật đã chạy cho 7B (còn lỗi nhỏ đã sửa); 7C-1 (thẻ phê duyệt, nhật ký, timer, phạm vi khoá) xong 2026-11-04; preset, phím tắt cơ bản, radio thẻ ngang xong. **Chặn bởi Phase 4:** 7C-2. **Chờ duyệt dependency:** 7D Tailwind/shadcn. Chưa làm: E2E người dùng mới, `PHASE7_REPORT.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3     | **ĐANG LÀM (từ 2026-11-04)** — quét CLI, probe `agy` (2/3 lượt), `adapter-antigravity` (qua contract test với CLI giả), capability router đã có; UI capability thiếu xong (Peer Review kiểm app thật); router đã nối vào `workflows.start` (UI có "Auto" + bật/tắt `agy`, chưa xem trong app thật); `packages/resource-monitor` đã nối vào sidecar (VRAM `nvidia-smi` + `/api/ps`, `trackedPids`, ngưỡng/concurrency trong Settings đã có; UI chưa xem trong app thật); `adapter-ollama` + tool loop + một model một lúc đã có (2026-11-08, chạy thật 1 lượt; tool thật chưa thử); còn chạy `agy` thật; xem PHASE3_REPORT                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4     | **ĐANG LÀM, CHƯA ĐÓNG** — phần đã ghép (CI 5/5 xanh ở `b370082`, kiểm app thật) và phần còn thiếu để đóng xem mục "Phase 4" bên dưới. Đã nối (opt-in, kiểm bằng giả): P4-1 c/d, `agent-job-wrap`, giới hạn RAM cả cây, P4-8 (b) resume (`maxRounds` đã lưu trong DB và có test vòng ≥ 2 với agent giả; CLI thật mới kiểm vòng 1), threat model (người dùng đã duyệt 2026-11-06), allowlist có hạn cho 13 crate Cargo trẻ, xác nhận duyệt bằng hộp thoại native (R3), trần RAM cả cây bằng Job Object (R4). Đã kiểm với CLI thật (2026-11-06, ASSUMPTIONS d6/d8): cổng Claude với `askEveryTool` phủ 6/6 tool thử, nhánh `accept` lệnh của Codex, soak 5 workflow thật, sửa lỗ symlink của artifact. Chặn đóng còn lại: quyết định bật mặc định hai cổng (đang TẮT theo quyết định người dùng) và nối `askEveryTool`/`jobMemLimitMb` vào cấu hình mặc định, installer thật BLOCKED (thiếu NSIS/WiX), Low IL PARTIAL (không chặn đọc/mạng; đăng nhập/gọi model BLOCKED vì credential), hộp thoại native chưa kiểm trong app Tauri thật |
| 5–6   | Chưa bắt đầu (Phase 5 chờ Phase 4 đóng; Phase 6 chờ Phase 5, `mcp-gateway` tối thiểu kéo lên đầu)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8–10  | Kế hoạch mở rộng "ngang AionUi, hơn ở an toàn / tin cậy / multi-agent / nhẹ" — xem cuối tài liệu; chưa bắt đầu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Thứ tự thực hiện (chốt lại 2026-11-04)

Thay cho thứ tự 2 → 7 → 8 → 9 (chốt 2026-11-02), vì thứ tự cũ có phụ thuộc ngược: 7C cần Policy Engine (Phase 4); Phase 8 cần MCP gateway (Phase 6) và Policy Engine; Phase 9 (lịch chạy "không vượt policy") cần Policy Engine; gate Phase 7 về diagnostics cần Phase 4; Phase 5 và Phase 7 trùng phần UI. Lý do và đánh đổi: `docs/DECISIONS.md` (ADR-005).

| Bước        | Nội dung                                                                                                                                                                                                                                        | Điều kiện vào                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1           | **Phase 7 phần không cần policy**: nợ UI (A8/B6), kiểm 7A với CLI thật, 7C-1 (một lần / từ chối, nhật ký quyết định, timer hết hạn fail-closed, mô hình `ApprovalScope` với nút phạm vi bị khoá), 7D (Tailwind/shadcn, theme, phím tắt), preset | Phase 2 đóng                 |
| 1 song song | **Phase 3** (probe `agy`, `adapter-antigravity`, capability routing, resource monitor). Ollama đã làm 2026-11-08 khi máy có                                                                                                                     | Không phụ thuộc              |
| 2           | **Phase 4** (Policy Engine, cô lập, recovery, observability, diagnostics export, soak test) rồi **7C-2** (bật "Luôn cho phép trong phạm vi") và đóng Phase 7 (`PHASE7_REPORT.md`, E2E người dùng mới)                                           | Bước 1 xong                  |
| 3           | **Phase 5** Desktop Beta: gộp phần UI trùng với Phase 7 (Approval Center, Diff Viewer, Settings), Live Terminal, installer, wizard, Playwright e2e, beta ≥ 3 dự án                                                                              | Phase 4 đóng                 |
| 4           | **Phase 6** Production 1.0 (signing, auto-update, pipeline, ma trận tương thích CLI, tài liệu vận hành). **`mcp-gateway` tối thiểu kéo lên đầu bước này** vì Phase 8 cần                                                                        | Phase 5 đóng                 |
| 5           | **Phase 8** ACP, MCP, Skills                                                                                                                                                                                                                    | Phase 4 đóng + `mcp-gateway` |
| 6           | **Phase 9** Multi-agent có cấu trúc, lịch chạy                                                                                                                                                                                                  | Phase 4 và 8 đóng            |
| xuyên suốt  | **Phase 10**: ngân sách hiệu năng chạy trong CI từ Phase 5; diagnostics một nút; ADR Remote/WebUI                                                                                                                                               | Song song Phase 5–6          |

Mỗi phase vẫn chỉ đóng khi đạt Acceptance gate của chính nó.

## Tổng quan

| Phase | Tên                    | Thời gian | Kết quả chính                                                                                   |
| ----- | ---------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| 0     | Foundation             | 3–5 ngày  | Monorepo, Tauri shell, SQLite+migrations, contracts, stub adapter, logging, CI                  |
| 1     | Single-Agent MVP       | 1–2 tuần  | Claude + Codex chạy task độc lập, streaming, cancel, session mapping                            |
| 2     | Multi-Agent            | 1–2 tuần  | Message router, task DAG, supervisor, QA handoff, worktrees → **MVP có giá trị**                |
| 3     | Quét CLI & Local AI    | 1–2 tuần  | Quét CLI agent trên máy, Antigravity (`agy`), Ollama + tool loop, capability routing, scheduler |
| 4     | Security & Reliability | 2–3 tuần  | Policy engine, sandbox tests, recovery, observability                                           |
| 5     | Desktop Beta           | 1–2 tuần  | UI hoàn chỉnh, settings, installer Windows, beta test                                           |
| 6     | Production 1.0         | 2–4 tuần  | Release engineering, update có chữ ký, MCP gateway tối thiểu, tài liệu vận hành (A2A → v1.1)    |

Tổng Phase 0–6 ≈ 9–18 tuần. Phase 7–10 (mở rộng sản phẩm) ≈ 8–14 tuần thêm.

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

- [x] Desktop app mở được (runner + máy Windows vật lý, bản debug).
- [x] Migrations chạy từ DB rỗng và idempotent.
- [x] Stub agent phát chuỗi AgentEvent đã validate bằng Zod.
- [x] `lint`, `typecheck`, `test`, `build` pass trên CI.
- [x] Không có secrets/đường dẫn cá nhân trong repo (secret scan sạch).
- [x] Mọi giả định chưa kiểm chứng được ghi trong ASSUMPTIONS.md.
- [x] Spike sidecar có kết quả ghi trong ADR-001 (thành công hoặc phương án thay thế).

Ghi chú: spike `node-pty` chưa làm; installer chưa build. Chi tiết: `docs/PHASE0_REPORT.md`.

## Phase 1 — Single-Agent MVP (1–2 tuần)

**Trạng thái: ĐÓNG (2026-11-02), có ba ngoại lệ** — chi tiết và bằng chứng: `docs/PHASE1_REPORT.md`. CI xanh 5/5 job ở run `41551598060`. Claude 2.1.314 và Codex 0.165.0 chạy task thật và hủy được giữa chừng (adapter và nút Cancel trong app Tauri release), không còn tiến trình mồ côi. Ngoại lệ chuyển sang phase sau: "sai version" (Phase 6), bản release trên máy thứ hai/installer (Phase 5), tool ghi/phê duyệt của CLI thật (Phase 2/4). Nợ Phase 1: `tasks.list` đã trả ở Phase 2, policy `projects.rootPath`, Browse và Settings → Agents đã trả ở 7B; còn UI phê duyệt đầy đủ (7C). Chi tiết: `docs/TODO.md`.

**Việc làm ngoài phạm vi Phase 1 (theo yêu cầu người dùng):** làm lại UI (theme sáng/tối, sidebar, Settings, bố cục 3 cột, composer, thẻ lỗi). Mode "Multi-agent" hiện chỉ gửi cùng mục tiêu cho ≥ 2 agent chạy độc lập, chưa điều phối (điều phối thật: Phase 2/9). Không giả lập tính năng backend chưa có.

**Phase 2: ĐÓNG (2026-11-03), có ngoại lệ** — xem `docs/PHASE2_REPORT.md`. **Bước tiếp theo: Phase 7 (phần không cần policy) song song Phase 3, rồi Phase 4** (thứ tự chốt lại 2026-11-04, xem mục "Thứ tự thực hiện").

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

- [x] Claude và Codex mỗi bên chạy được 1 task thật độc lập (2026-11-02, xem PHASE1_REPORT).
- [x] Cancel dừng cả process tree (test không còn orphan) — đã chạy thật với claude 2.1.314 và codex 0.165.0, cả trực tiếp qua adapter lẫn bấm Cancel trong app Tauri release: 0 `ping.exe` và 0 sidecar còn lại.
- [~] Lỗi CLI (không cài, sai version, exit ≠ 0, JSON hỏng) được báo rõ, không crash — đạt trừ "sai version" (chưa có version tối thiểu được kiểm chứng; chuyển Phase 6).
- [~] Contract tests với fixture output thật đã ghi lại của từng CLI — đạt có giới hạn (xem PHASE1_REPORT).
- [x] CI xanh (run `41551598060`).

## Phase 2 — Multi-Agent Collaboration (1–2 tuần) → MVP

- Durable Message Router: outbox/inbox, sequence per task, ack, dedupe theo `id`/`correlationId`, retry backoff + jitter, dead-letter, backpressure.
- Transaction ghi state + outbox cùng lúc.
- Task DAG + scheduler (priority, dependency, lease, giới hạn concurrency mặc định 2).
- `packages/git-worktrees`: tạo/dọn worktree theo task, branch naming, phát hiện conflict, bảng `worktrees`.
- Workflow engine: Supervisor + Peer Review + Parallel Workers.
- Handoff mẫu: Claude implement → Codex review (`review.request` / `review.result`).
- **Vai (role) cho agent trong workflow:** mỗi vai khai hướng dẫn, quyền (chỉ đọc / ghi trong worktree) và agent được phép đảm nhiệm; gán agent vào vai là cấu hình của lượt chạy, không hard-code theo tên agent.
- **Bảng ngữ cảnh chung (mức tối thiểu):** mỗi lượt chạy có một bảng gồm mục tiêu, kế hoạch, quyết định và artifact (path + hash); mỗi mục ghi nguồn (verified / agent-reported). Agent chỉ nhận phần bảng mà vai của nó được thấy, và không đọc log thô của agent khác.
- Artifact registry (path + hash), diff viewer, message timeline.
- Approval Center cơ bản (`approvals.resolve`).

**Acceptance gate** (đạt 2026-11-03, có ngoại lệ: xem `docs/PHASE2_REPORT.md`)

- [x] Workflow thật "implement → review" chạy không cần copy tay giữa terminal.
- [x] Kill app giữa chừng → restart không mất message đã commit; duplicate được xử lý an toàn.
- [x] 2 agent song song trên 2 worktree không ghi đè nhau.
- [x] Task side-effect không rõ → `needs_reconciliation`, không auto-retry.
- [x] Gán vai cho agent trong một workflow thật; agent chỉ nhận đúng phần bảng ngữ cảnh mà vai được thấy (test).

## Phase 3 — Quét CLI & Local AI (1–2 tuần)

- **Quét CLI agent (nâng cấp):** danh sách ứng viên khai báo bằng dữ liệu (tên lệnh, cờ `--version`/`--help`), dò trong PATH và vị trí cài thường gặp trên Windows; mỗi CLI tìm thấy được ghi đường dẫn, version và bảng capability suy từ `--help`. Chỉ CLI đã có adapter và qua contract test mới chạy được task; CLI chỉ được phát hiện thì hiển thị "đã phát hiện, chưa hỗ trợ" (không giả lập). Gemini CLI không nằm trong phạm vi.
- `AntigravityAdapter` (lệnh `agy`; **ngoài phạm vi gate Phase 3 từ 2026-11-08, ADR-009**; code giữ nguyên): chỉ làm sau khi probe thật trên máy chứng minh `--print` + `--output-format stream-json`; parse theo fixture thật, ghi vào `docs/ASSUMPTIONS.md`.
- `OllamaAdapter`: HTTP API streaming, discover models, tool-calling loop riêng với tool whitelist; mặc định read-only.
- Capability-based routing (không hard-code theo tên agent).
- Resource-Aware Scheduler: theo dõi RAM/VRAM, 1 model Ollama tại một thời điểm, tạm ngừng nhận local inference khi thiếu tài nguyên.
- UI hiển thị rõ khả năng agent không hỗ trợ (resume/approval…) thay vì giả lập.

**Acceptance gate**

- [ ] Mọi adapter trong phạm vi gate (Claude, Codex, Ollama; `agy` ngoài gate, ADR-009) qua cùng bộ contract test.
- [ ] Thêm adapter mới không sửa Orchestrator core.
- [ ] Hết VRAM/RAM → hệ thống degrade có kiểm soát, không treo máy.

> Tình trạng 2026-11-08 (KHÔNG tick gate): RAM/CPU degrade đã nối qua admission, đo pid con Windows và ngưỡng/concurrency trong Settings; VRAM, Ollama (kể cả discover models qua `/api/tags`) và một model một lúc đã có mã + test (S1–S6, `e2fe785`); VRAM mặc định TẮT (người dùng giữ nguyên, 2026-11-08); còn kiểm giao diện trong app thật và tool calling thật. Xem `docs/PHASE3_REPORT.md`.

## Phase 4 — Security & Reliability (2–3 tuần)

**Trạng thái (2026-11-05): ĐANG LÀM, chưa đóng.** Bằng chứng: `docs/PROGRESS.md` (mục 2026-11-05), `docs/SECURITY.md`, `docs/DEPS_AUDIT.md`.

- **Đã ghép, CI xanh 5/5 (`b370082`), kiểm trong app Tauri thật:** policy engine mã thuần (path scope, command policy; test 8.3 qua trên runner Windows), Job Object cho sidecar (kill đột ngột app thì sidecar chết), capabilities `default` chỉ còn event listen/unlisten, recovery 5 bước + UI (5 bước là giả định chờ duyệt), log rotation + `diagnostics.export`, audit + ghim Actions theo SHA, AppContainer chỉ ở mức tài liệu (không có prototype).
- **Còn thiếu để đóng:** (1) P4-1 c/d: cổng quyền đã nối opt-in và TẮT mặc định; với `askEveryTool` + cổng thật + claude thật, 6/6 tool thử đều tới cổng (Edit/Glob/Grep lúc đó bị từ chối vì `requestFor` chưa phủ; nay đã ánh xạ, chỉ test bằng stub, chưa kiểm lại với claude thật); nhánh `accept` lệnh của Codex đã quan sát; còn lại: quyết định bật mặc định, sidecar chưa truyền `askEveryTool`, tool ngoài 6 tool chưa thử; (2) `agent-job-wrap` đã nối vào process-manager và bật mặc định trong sidecar khi tìm thấy binary; trần cứng cả cây `--job-mem-limit-mb` đã đo (R4) nhưng chưa nối vào cấu hình mặc định; còn lại: build installer thật (BLOCKED: máy không có NSIS/WiX, bundler sẽ tải về); đã kiểm 2026-11-06 với claude/codex thật (ASSUMPTIONS d9): chạy qua wrapper, Ctrl+C, CTRL_BREAK, kill wrapper và kill lồng dọn sạch cả cây, mã thoát 32 bit không còn bị cắt; chưa kiểm kill app Tauri thật với CLI thật bên trong; (3) P4-8 (b) engine resume Peer Review: ĐÃ CÓ từ 7A, có test khi reviewer bị ngắt (2026-11-06); `maxRounds` tuỳ chỉnh được lưu và test resume vòng ≥ 2 với agent giả (2026-11-07); CHƯA kiểm CLI thật ở vòng ≥ 2; (4) threat model: ĐÃ CÓ và người dùng đã duyệt (2026-11-06); tuổi gói transitive: npm 0 gói trẻ, Cargo 13 crate trẻ nằm trong allowlist có hạn (hết hạn thì CI đỏ lại); (5) soak 100 workflow và security tests: xong với agent giả (chứng minh bất biến của orchestrator, SQLite và worktree thật, KHÔNG chứng minh hành vi CLI thật); với CLI thật mới 5 workflow (xanh, có số liệu từng workflow và 0 CLI mồ côi thấy được, 1 lần chạy), 100 workflow thật chưa chạy; lỗ symlink của artifact đã sửa (còn hở TOCTOU, hard link, mount point); (6) Low IL: PARTIAL, chặn ghi nhưng không chặn đọc/mạng, đăng nhập/gọi model thật BLOCKED (cần người dùng tự đăng nhập trong thư mục cấu hình tạm gán nhãn low); (7) hộp thoại xác nhận native (R3, T12) chưa kiểm trong app Tauri thật.

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

## Hướng mở rộng: ngang AionUi, hơn ở bốn điểm (Phase 7–10)

Tham chiếu: AionUi/AionCore (Apache-2.0, chỉ đọc ý tưởng, không sao chép code; xem `docs/REFERENCES.md`). Quyết định đã chốt với chủ dự án (2026-11-02):

- **Đối tượng:** cá nhân/dev, Windows trước. Remote/WebUI và làm việc nhóm **ngoài phạm vi** cho tới khi có nhu cầu mới.
- **Giao thức agent:** native CLI trước; **ACP là adapter bổ sung ở Phase 8**, kèm compatibility test, không thay lõi.
- **Khác biệt cần thắng:** (1) an toàn và kiểm soát, (2) độ tin cậy, (3) multi-agent có cấu trúc, (4) nhẹ và nhanh.

AionUi thiên về hội thoại tự do, nhiều agent và nhiều kênh (YOLO mode, chat nhóm, WebUI, kênh nhắn tin). Agent Workspace thiên về **tác vụ có thể kiểm chứng**: mỗi việc có trạng thái bền, quyền rõ ràng và bằng chứng kết quả.

| Điểm hơn           | Cam kết đo được                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| An toàn, kiểm soát | Không có chế độ "tự duyệt tất cả" mặc định; mọi quyền ghi/chạy lệnh đi qua policy; ghi nhật ký quyết định; báo rõ phần không sandbox |
| Tin cậy            | Kill app giữa chừng không mất state; task không chắc kết quả → `needs_reconciliation`; có bảng "đã xác minh / agent báo / ước tính"  |
| Multi-agent        | Workflow có cấu trúc (implement → review, song song trên worktree), handoff mang bằng chứng, không chat tự do                        |
| Nhẹ, nhanh         | Tauri + sidecar; có ngân sách đo được cho khởi động, RAM nhàn rỗi, kích thước installer, độ trễ event                                |

### Phase 7 — Ngang AionUi về trải nghiệm cốt lõi (2–3 tuần, sau Phase 2)

**Tiến độ:** lát 7A (lịch sử task, tìm log, engine resume, UI giải quyết reconciliation) đã có code và test; còn kiểm với CLI thật và trong app Tauri. lát 7B (chọn thư mục qua backend, policy `rootPath`, Settings → Agents, secrets vào Credential Manager) đã có code và test, đã kiểm trong app Tauri thật. 7C-1 xong (2026-11-04); preset, phím tắt cơ bản và radio thẻ ngang xong. Còn: 7C-2 (sau Phase 4), 7D Tailwind/shadcn (chờ duyệt dependency), E2E người dùng mới.

Lấp khoảng trống UX so với AionUi, nhưng theo cách task-centric.

- Lịch sử: `tasks.list`, lọc theo project/agent/trạng thái, mở lại log và kết quả; tìm kiếm trong log.
- Chọn thư mục bằng hộp thoại hệ điều hành (qua backend, không để frontend tự chạm filesystem).
- Trang **Settings → Agents**: command, args, env cho từng agent; kiểm tra bằng probe; bí mật vào Credential Manager, không ghi DB.
- **Approval UI** đầy đủ: thẻ Cho phép một lần / Luôn cho phép trong phạm vi / Từ chối; hiển thị lệnh, đường dẫn, diff dự kiến; mọi quyết định ghi vào nhật ký.
- Giao diện hoàn thiện: Tailwind/shadcn, dark/light, phím tắt, trạng thái rỗng và lỗi nhất quán.
- Mẫu prompt và "assistant" cục bộ: preset (agent + quyền + hướng dẫn), lưu dạng file có thể export.

**Acceptance gate**

- [ ] Người dùng mới đi từ cài đặt → thêm project → chạy task thật mà không đụng terminal (đo bằng kịch bản E2E).
- [ ] Mọi yêu cầu phê duyệt hiển thị đủ lệnh/đường dẫn; từ chối không làm treo task.
- [ ] Không có mật khẩu/token nào xuất hiện trong DB, log hoặc diagnostics (test redaction). Đã có test cho DB, log, IPC, sự kiện đẩy ra và gói diagnostics (nối IPC 2026-11-05, kiểm trong app thật: không rò đường dẫn); chưa tick vì che chỉ theo giá trị chính xác (xem SECURITY.md) và chưa kiểm redaction secret thật trong bundle.

### Phase 8 — Mở rộng agent: ACP, MCP, Skills (2–3 tuần)

- **ACP adapter** (Agent Client Protocol): chỉ sau khi có probe + contract test với ít nhất hai agent thật; ghi capability thực tế vào ASSUMPTIONS, không gọi "tương thích" khi chưa qua test.
- Mọi permission request từ ACP đi qua cùng Policy Engine và Approval UI như CLI native.
- **MCP**: quản lý danh sách MCP server theo project, bật/tắt từng tool, hiển thị quyền; gateway tối thiểu (xem Phase 6, kéo lên đầu bước 4) là điều kiện tiên quyết.
- **Skills/prompt packs**: nạp từ thư mục project, hiển thị nguồn và hash; mặc định chỉ đọc; không tải mã từ mạng khi chưa có xác nhận.
- Process registry khi khởi động: ghi PID + thời điểm tạo, chỉ dọn tiến trình mồ côi khi khớp danh tính, tránh kill nhầm.
- Hạn mức thời gian khởi tạo cho từng CLI/ACP (lạnh dài hơn nóng) và báo lỗi có nguyên nhân.

**Acceptance gate**

- [ ] Thêm agent ACP thứ hai không sửa Orchestrator core.
- [ ] Permission từ ACP bị chặn đúng theo policy trong test (path escape, lệnh bị cấm).
- [ ] Skill/MCP không rõ nguồn không thể kích hoạt âm thầm.

### Phase 9 — Multi-agent có cấu trúc vượt "team chat" (2–3 tuần)

- Mẫu workflow đóng gói được: implement → review → fix, song song N worker trên worktree, kiểm tra chéo; xuất/nhập dạng file.
- Handoff mang bằng chứng: diff, kết quả test, hash artifact; reviewer thấy đúng những gì worker đã làm, không dựa vào lời kể.
- **Đội (team) trong UI Multi-agent:** chọn mẫu workflow, gán agent vào từng vai, xem kế hoạch và tiến độ từng bước; thay chế độ hiện tại ("mọi agent nhận cùng mục tiêu, chạy độc lập, không phối hợp").
- **Chia sẻ ngữ cảnh có kiểm soát:** bảng ngữ cảnh chung có giới hạn kích thước (chi phí token), tóm tắt có nguồn, hiển thị cho người dùng đúng phần mỗi agent được nhận; mọi mục sửa/xóa đều ghi nhật ký. Không có chat tự do giữa các agent.
- **Giới hạn phải nói rõ trong UI:** Claude và Codex mỗi bên giữ phiên riêng; "ngữ cảnh chung" là văn bản dự án đưa vào prompt, không phải bộ nhớ dùng chung (xem ASSUMPTIONS.md).
- Bảng **verified / agent-reported / estimated** trên mọi màn hình trạng thái.
- Lịch chạy (scheduled tasks) với giới hạn: không chạy khi app đóng trừ khi người dùng bật dịch vụ nền; mỗi lần chạy đều qua policy; side effect không rõ → `needs_reconciliation`.
- Gộp kết quả worktree an toàn: xem trước xung đột, không tự merge vào nhánh chính.

**Acceptance gate**

- [ ] 3 workflow mẫu chạy thật trên dự án mẫu, kết quả có thể tái lập.
- [ ] Kill app giữa workflow → mở lại → trạng thái đúng, không lặp side effect.
- [ ] Lịch chạy không bao giờ vượt policy đã cấp, kể cả khi người dùng vắng mặt.
- [ ] UI Multi-agent chạy một đội có vai và bảng ngữ cảnh chung trên dự án mẫu; người dùng thấy được agent nào nhận phần ngữ cảnh nào.

**Thứ tự (chốt lại 2026-11-04, thay cho 2 → 7 → 8 → 9 của 2026-11-02):** xem mục "Thứ tự thực hiện" đầu tài liệu. Phase 9 đứng sau Phase 4 và 8; phần "đội, vai, ngữ cảnh" của Phase 9 vẫn không được đẩy lên trước Phase 7–8; phần tối thiểu (vai, bảng ngữ cảnh) vẫn nằm ở Phase 2.

### Phase 10 — Nhẹ, nhanh, hoàn thiện sản phẩm (1–2 tuần, song song Phase 5–6)

- Ngân sách hiệu năng chốt từ baseline Phase 1 và chạy trong CI: thời gian khởi động, RAM nhàn rỗi, RAM khi 2 task, kích thước installer, độ trễ event.
- So sánh công khai với số đo của chính mình theo từng bản phát hành (không đặt số của đối thủ vào tài liệu nếu chưa tự đo).
- Chế độ chẩn đoán: xuất gói diagnostics đã redact, một nút.
- Đánh giá lại Remote/WebUI và làm việc nhóm: chỉ mở phase mới nếu có yêu cầu và có mô hình xác thực được duyệt (ADR riêng).

**Acceptance gate**

- [ ] Vượt ngân sách hiệu năng → CI đỏ.
- [ ] Diagnostics không chứa secret hoặc đường dẫn cá nhân (test).

### Ngoài phạm vi (cố ý)

Chế độ tự duyệt tất cả (YOLO), kênh nhắn tin (WeChat/DingTalk/Lark), desktop pet, WebUI công khai, hub extension tải mã từ mạng. Mở lại khi có yêu cầu và ADR đánh giá rủi ro.

## Rủi ro chính

| Rủi ro                                          | Giảm thiểu                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| CLI đổi flag/format giữa các phiên bản          | Compatibility probe + fixture contract tests + pin phiên bản hỗ trợ                |
| Agent ghi file ngoài phạm vi                    | Policy engine + Job Object; không dựa vào worktree làm sandbox                     |
| Retry gây side effect trùng                     | `needs_reconciliation`, idempotent handler                                         |
| Orphan process trên Windows                     | Job Objects, test cancel                                                           |
| Hết RAM/VRAM (16 GB / 8 GB)                     | Resource-aware scheduler, concurrency mặc định 2                                   |
| Phụ thuộc/nội dung repo công khai không an toàn | Chính sách trong `CLAUDE.md`, ghi `docs/REFERENCES.md`                             |
| Scope creep (thêm nhiều LLM, UI sớm)            | Chỉ đóng phase khi đạt gate                                                        |
| Đuổi tính năng AionUi, mất lợi thế an toàn      | Phase 7–10 chỉ nhận tính năng qua Policy Engine + Approval; có mục "Ngoài phạm vi" |
| Phụ thuộc adapter ACP của bên thứ ba            | ACP là adapter bổ sung, có probe + contract test; native CLI vẫn là lõi            |
