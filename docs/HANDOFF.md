# Bàn giao tiến độ

Cập nhật: 2026-11-05 (nhánh làm việc ở `c85d130`, chưa push; nhánh gốc còn ở `f75a72b`). Nhật ký chi tiết theo thời gian nằm ở `docs/PROGRESS.md`; file này chỉ nêu trạng thái hiện tại để người tiếp quản đọc nhanh.

## Vị trí

- Nhánh làm việc `claude/repo-current-status-acfd51` có `8143aea` (gồm Phase 7 UI, Phase 3, sửa scheduler flaky, UI capability thiếu, sửa bố cục hẹp; đã kiểm trong app Tauri thật); PR #2 vào nhánh gốc đang mở (chưa merge, auto-fix bật, auto-merge tắt). Nhánh gốc `claude/loving-lovelace-32lh71` (cũng là `origin/HEAD`) còn ở `f75a72b`, chưa fast-forward. PR #1 đã MERGED.
- Thứ tự phase đã chốt lại 2026-11-04 (ADR-005, ROADMAP mục "Thứ tự thực hiện"): Phase 7 (phần không cần policy) song song Phase 3 → Phase 4 (+ 7C-2, đóng Phase 7) → Phase 5 → Phase 6 (`mcp-gateway` đầu) → Phase 8 → Phase 9; Phase 10 xuyên suốt.
- Ứng dụng: **Agent Workspace** (Tauri 2 + React/Vite, sidecar Node orchestrator, SQLite/Drizzle, pnpm monorepo).
- Giữ nguyên `identifier` `dev.agentstudio.desktop`, gói `@agent-studio/*`, service Credential Manager `agent-studio` (đổi sẽ mất dữ liệu và secret đã lưu).

## Trạng thái các phase

| Phase                                              | Trạng thái                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0, 1                                               | Đóng (`PHASE0_REPORT.md`, `PHASE1_REPORT.md`)                                                                                                                                                     |
| 2 Peer Review MVP                                  | Đóng 2026-11-03, có ngoại lệ, tag `mvp-phase2`                                                                                                                                                    |
| 7A (lịch sử task, reconciliation)                  | Xong, kiểm trong app Tauri thật                                                                                                                                                                   |
| 7B (project policy, cấu hình agent, secrets)       | Xong, kiểm trong app Tauri thật                                                                                                                                                                   |
| Quét CLI (`agents.scan`)                           | Đã gộp (`2380045`); chỉ phát hiện, chưa chạy task                                                                                                                                                 |
| Redaction secret                                   | Xong (`3a9a85b`), chỉ che theo giá trị chính xác                                                                                                                                                  |
| 7C-1 (thẻ phê duyệt, nhật ký, timer, phạm vi khoá) | Xong 2026-11-04, kiểm trong app Tauri thật; chưa có đường production tạo approval (Phase 4)                                                                                                       |
| Preset, phím tắt cơ bản, radio thẻ ngang           | Xong 2026-11-04, đã kiểm trong app Tauri thật (trừ Ctrl+Enter gửi thật cần CLI)                                                                                                                   |
| 3 (quét CLI, `agy`, router)                        | Đang làm: adapter `agy` (CLI giả), router, UI capability thiếu (Peer Review kiểm app thật; nhánh AgentView chỉ có unit test) xong; còn Ollama, resource monitor, nối router vào `workflows.start` |
| 4 Policy Engine (mã thuần)                         | Có `packages/policy-engine` (merge `c85d130`, từ phiên cloud); đã sửa `..` theo Win32, test xanh trên Windows (2026-11-05); chưa nối vào orchestrator/IPC/UI                                      |
| 7C-2, 7D Tailwind/shadcn, E2E người dùng mới       | Chưa bắt đầu (7C-2 chờ Phase 4; Tailwind/shadcn chờ duyệt dependency)                                                                                                                             |
| `PHASE7_REPORT.md`                                 | Chỉ viết khi cả Phase 7 đạt tiêu chí đóng                                                                                                                                                         |

`claude`, `codex` chạy được task thật; `agy` (Antigravity 1.4.8) đã có adapter (thành công chỉ khi `num_turns` > 0 và `response` không rỗng) nhưng mới qua contract test với CLI giả, chưa chạy `agy` thật (còn 1 lượt probe cần người dùng cho phép). Gemini đã bỏ khỏi roadmap và khỏi README/CLAUDE.md.

## CI

- Commit `1009755`: đủ 5 job xanh (Security chạy khoảng 41 phút với bản quét cũ; bản quét mới chưa có số đo trên CI).
- `babca05` đỏ do Prettier lệch ở `docs/HANDOFF.md`; `868daef` (đã format lại) xanh đủ 5/5 job (2026-11-04). PR #1 đã merged nên không còn PR nào được ứng dụng theo dõi.
- `3d5925f`: TypeScript (ubuntu, windows), Tauri và một lượt Security (bản quét mới, lần đầu trên Linux) xanh; chưa đọc đủ kết luận các lượt còn lại.
- `1540a4f`: xanh cả 10 check run (2026-11-04). Security chạy 7,1 phút (push) và 5,9 phút (pull_request) với bản quét mới, so với khoảng 41 phút trước đó.
- `f75a72b`: chưa có kết luận (lần đọc gần nhất: TypeScript ubuntu xanh, các job khác còn chạy/xếp hàng).
- `7275822`: xanh đủ 5/5 job (TypeScript ubuntu 1 phút 26 giây, windows 2 phút 25 giây, Tauri 5 phút 13 giây, Security 9 phút 20 giây, spike 5 phút 27 giây; phiên con `ci-read-48ff83e` đọc bằng GraphQL, tôi chưa tự đọc lại). `48ff83e` có TypeScript ubuntu đỏ ở `pnpm test`: `services/orchestrator/src/scheduler.test.ts` "never runs more than `concurrency` tasks at once" hết 5000ms (phiên con `ci-log-48ff83e` đọc log); không có thay đổi nào ở scheduler giữa `48ff83e` và `7275822`. Chạy cục bộ 40 lần song song (8 luồng × 5) đều qua, chưa tái hiện; nghi ngờ phụ thuộc thời điểm (`setImmediate` rồi `tick`), chưa chứng minh. PR #2: chưa đọc kết quả CI của `cdd2c06`/`a3f9d20`.
- Đọc CI bằng GraphQL (`checkSuites`/`checkRuns`), không dùng `gh run view`/`gh run watch` (REST từng chạm trần 5000/giờ, trả 403).
- `3a9a85b` có chuỗi secret giả trong test. Nếu bộ quét báo, chỉ thêm đúng tuple đã rà soát vào danh sách chấp nhận của `scripts/secret-scan.py`, không nới lỏng bộ quét.

## Việc tiếp theo (theo thứ tự)

1. Đọc CI của `7275822` (và các commit trước); nếu Security đỏ do script, sửa `scripts/secret-scan.py`. Sau đó fast-forward nhánh gốc nếu xanh.
2. Phase 3 còn lại: UI capability thiếu (render `describeCapabilityGap` ở `apps/desktop`), nối router vào `workflows.start`, resource monitor; chạy `agy` thật qua adapter (xin phép lượt probe). Ollama hoãn (máy chưa cài).
3. Phase 7 còn lại: Tailwind/shadcn (cần duyệt dependency: pin ≥ 2 tuần, audit, license, `docs/REFERENCES.md`), kiểm preset/phím tắt trong app thật, E2E người dùng mới. (`CLAUDE.md` đã sửa trong `c85d130`.) 7C-2 và đóng Phase 7 chờ Phase 4.

## Chờ người dùng quyết

- Push nhánh `claude/repo-current-status-acfd51` (đứng trước `origin` 6 commit) lên PR #2.

- Dọn A5 không làm mất dữ liệu người dùng: mục `index/claude.agent-studio` đã xoá là danh sách TÊN secret của provider claude do chính app tạo (`secrets.rs`), nhiều khả năng là tàn dư kiểm 7B; người dùng xác nhận chưa từng nhập secret nào. Không có mục thì Settings hiện danh sách rỗng (NoEntry → rỗng), không lỗi.
- Nhánh `claude/phase-2-kickoff-8a5732` là bản Phase 2 cũ, xung đột add/add; khuyến nghị không gộp.

## Chưa xác minh / nợ nhỏ

- 2026-11-05 trên Windows (sau sửa `..` theo Win32): lint, prettier, typecheck, build qua; `pnpm test` 485 qua, 2 bỏ qua (test POSIX), 0 đỏ. `process-manager` \"cancels via AbortSignal\" hết 30 giây 1 lần ở lần chạy trước (qua 2/2 khi chạy riêng và qua ở lần chạy sau): nghi flaky, chưa điều tra. `cargo clippy`/`cargo test` chưa chạy lại. CI chưa có (chưa push).

- 2026-11-04 (sau 7C-1): `pnpm lint`, `typecheck`, `test` (44 file, 389 test), `build` qua. Rust không đổi nên `cargo clippy`/`cargo test` chưa chạy lại (lần trước: clippy sạch, 12 test qua, 1 bỏ qua). `cargo audit` 0.22.2: không lỗ hổng; hai cảnh báo transitive (`proc-macro-error` không bảo trì, `glib 0.18.5` unsound).
- Đã kiểm trong app thật (2026-11-04): thẻ phê duyệt, Decision log, History (Older, giờ), sidebar hẹp, theme tối. B1 (resume Peer Review với CLI thật) đạt cả hai chiều claude↔codex.
- Timer hết hạn 5 giây chỉ được chứng minh bằng test đơn vị; trong app thật UI poll `approvals.list` (cũng gọi `expireDue`) nên chưa tách riêng được.
- Chưa kiểm trong app thật: Settings > Agents Save/Use defaults, Peer Review chạy CLI thật qua UI. Danh sách radio "What happened?" trong thẻ reconciliation xếp dọc, trông lỏng (chưa sửa).
- Secret có thể lọt vào log nếu CLI tự in môi trường của nó (redaction không bao phủ giá trị bị biến đổi).
- Test flaky đã biết: `scheduler.test.ts` (timeout 5 giây trên CI ubuntu, 1 lần ở `48ff83e`), `sidecar-resume.test.ts` (1 lần cục bộ khi máy tải), `git-worktrees` (1 lần). Chưa nới timeout; hướng sửa đề xuất: chờ điều kiện rõ ràng thay vì `setImmediate`.
- Test `git-worktrees` từng flaky một lần; `logs.search` (LIKE) chưa benchmark.

## Quy ước làm việc

- Trả lời tiếng Việt có dấu. Kiểm thử app chạy ngầm, không dùng chuột/bàn phím của người dùng.
- Spawn process bằng mảng đối số, `shell: false`. Worktree không phải sandbox. Task có side effect không xác minh được → `needs_reconciliation`, không tự retry.
- Method IPC mới cần sửa 4 chỗ: Zod variant (`contracts`), `case` trong `sidecar.ts`, `ALLOWED_METHODS` + test trong `src-tauri/src/lib.rs`, stub trong `apps/desktop/src/preview-sidecar.ts`.
- Push gộp theo lô vì Security chậm; chỉ push khi người dùng đồng ý.

## Chuyển sang Claude Cloud

Xem `docs/CLOUD_HANDOFF.md`: việc nào chạy được trên cloud, việc nào phải chờ máy Windows của người dùng.
