# ROADMAP — Agent Studio

Ước lượng cho 1 developer có AI hỗ trợ; không phải cam kết. Mỗi phase chỉ đóng khi đạt **Acceptance gate**. Chi tiết việc cần làm: `docs/TODO.md`.

Nguyên tắc ưu tiên: **Agent Runtime → Message Router → Durable Task State → Permission Engine** trước, UI và số lượng LLM sau.

## Tiến trình (cập nhật 2026-11-02)

| Phase | Trạng thái                                                                                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | **PASS (có hạn chế)** — CI xanh (runner), đã xác minh trên Windows vật lý bằng `tauri dev`; xem PHASE0_REPORT                                                                                                        |
| 1     | **ĐÓNG (2026-11-02), có ngoại lệ** — cả 4 tiêu chí đạt/đạt có giới hạn, CI xanh; ngoại lệ chuyển phase sau (sai version → Phase 6, release máy thứ hai → Phase 5, tool ghi/phê duyệt → Phase 2/4). Xem PHASE1_REPORT |
| 2–6   | Chưa bắt đầu                                                                                                                                                                                                         |
| 7–10  | Kế hoạch mở rộng "ngang AionUi, hơn ở an toàn / tin cậy / multi-agent / nhẹ" — xem cuối tài liệu; chỉ bắt đầu sau Phase 2                                                                                            |

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

**Trạng thái:** backlog chia Sprint A (process manager, Job Object spike, state machine, migration) → B (probe CLI) → C (adapter) → D (IPC/UI) → E (đóng phase). Chi tiết: `docs/TODO.md`.

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
- [x] CI xanh (run `41526633402`).

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

**Acceptance gate**

- [ ] Workflow thật "implement → review" chạy không cần copy tay giữa terminal.
- [ ] Kill app giữa chừng → restart không mất message đã commit; duplicate được xử lý an toàn.
- [ ] 2 agent song song trên 2 worktree không ghi đè nhau.
- [ ] Task side-effect không rõ → `needs_reconciliation`, không auto-retry.
- [ ] Gán vai cho agent trong một workflow thật; agent chỉ nhận đúng phần bảng ngữ cảnh mà vai được thấy (test).

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

## Hướng mở rộng: ngang AionUi, hơn ở bốn điểm (Phase 7–10)

Tham chiếu: AionUi/AionCore (Apache-2.0, chỉ đọc ý tưởng, không sao chép code; xem `docs/REFERENCES.md`). Quyết định đã chốt với chủ dự án (2026-11-02):

- **Đối tượng:** cá nhân/dev, Windows trước. Remote/WebUI và làm việc nhóm **ngoài phạm vi** cho tới khi có nhu cầu mới.
- **Giao thức agent:** native CLI trước; **ACP là adapter bổ sung ở Phase 8**, kèm compatibility test, không thay lõi.
- **Khác biệt cần thắng:** (1) an toàn và kiểm soát, (2) độ tin cậy, (3) multi-agent có cấu trúc, (4) nhẹ và nhanh.

AionUi thiên về hội thoại tự do, nhiều agent và nhiều kênh (YOLO mode, chat nhóm, WebUI, kênh nhắn tin). Agent Studio thiên về **tác vụ có thể kiểm chứng**: mỗi việc có trạng thái bền, quyền rõ ràng và bằng chứng kết quả.

| Điểm hơn           | Cam kết đo được                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| An toàn, kiểm soát | Không có chế độ "tự duyệt tất cả" mặc định; mọi quyền ghi/chạy lệnh đi qua policy; ghi nhật ký quyết định; báo rõ phần không sandbox |
| Tin cậy            | Kill app giữa chừng không mất state; task không chắc kết quả → `needs_reconciliation`; có bảng "đã xác minh / agent báo / ước tính"  |
| Multi-agent        | Workflow có cấu trúc (implement → review, song song trên worktree), handoff mang bằng chứng, không chat tự do                        |
| Nhẹ, nhanh         | Tauri + sidecar; có ngân sách đo được cho khởi động, RAM nhàn rỗi, kích thước installer, độ trễ event                                |

### Phase 7 — Ngang AionUi về trải nghiệm cốt lõi (2–3 tuần, sau Phase 2)

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
- [ ] Không có mật khẩu/token nào xuất hiện trong DB, log hoặc diagnostics (test redaction).

### Phase 8 — Mở rộng agent: ACP, MCP, Skills (2–3 tuần)

- **ACP adapter** (Agent Client Protocol): chỉ sau khi có probe + contract test với ít nhất hai agent thật; ghi capability thực tế vào ASSUMPTIONS, không gọi "tương thích" khi chưa qua test.
- Mọi permission request từ ACP đi qua cùng Policy Engine và Approval UI như CLI native.
- **MCP**: quản lý danh sách MCP server theo project, bật/tắt từng tool, hiển thị quyền; gateway tối thiểu (xem Phase 6) là điều kiện tiên quyết.
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

**Đã chốt (2026-11-02):** giữ thứ tự Phase 2 → 7 → 8 → 9. Phần "đội, vai, ngữ cảnh" của Phase 9 không được đẩy lên trước Phase 7–8; phần tối thiểu (vai, bảng ngữ cảnh) vẫn nằm ở Phase 2.

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
