# Bàn giao tiến độ

Cập nhật: 2026-11-04 (đêm; nhánh làm việc ở `7275822`, nhánh gốc còn ở `f75a72b`). Nhật ký chi tiết theo thời gian nằm ở `docs/PROGRESS.md`; file này chỉ nêu trạng thái hiện tại để người tiếp quản đọc nhanh.

## Vị trí

- Nhánh làm việc `claude/repo-current-status-acfd51` đã push tới `7275822` (gồm merge Phase 7 UI và Phase 3). Nhánh gốc `claude/loving-lovelace-32lh71` (cũng là `origin/HEAD`) còn ở `f75a72b`, chưa fast-forward. PR #1 đã MERGED.
- Thứ tự phase đã chốt lại 2026-11-04 (ADR-005, ROADMAP mục "Thứ tự thực hiện"): Phase 7 (phần không cần policy) song song Phase 3 → Phase 4 (+ 7C-2, đóng Phase 7) → Phase 5 → Phase 6 (`mcp-gateway` đầu) → Phase 8 → Phase 9; Phase 10 xuyên suốt.
- Ứng dụng: **Agent Workspace** (Tauri 2 + React/Vite, sidecar Node orchestrator, SQLite/Drizzle, pnpm monorepo).
- Giữ nguyên `identifier` `dev.agentstudio.desktop`, gói `@agent-studio/*`, service Credential Manager `agent-studio` (đổi sẽ mất dữ liệu và secret đã lưu).

## Trạng thái các phase

| Phase                                              | Trạng thái                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 0, 1                                               | Đóng (`PHASE0_REPORT.md`, `PHASE1_REPORT.md`)                                                     |
| 2 Peer Review MVP                                  | Đóng 2026-11-03, có ngoại lệ, tag `mvp-phase2`                                                    |
| 7A (lịch sử task, reconciliation)                  | Xong, kiểm trong app Tauri thật                                                                   |
| 7B (project policy, cấu hình agent, secrets)       | Xong, kiểm trong app Tauri thật                                                                   |
| Quét CLI (`agents.scan`)                           | Đã gộp (`2380045`); chỉ phát hiện, chưa chạy task                                                 |
| Redaction secret                                   | Xong (`3a9a85b`), chỉ che theo giá trị chính xác                                                  |
| 7C-1 (thẻ phê duyệt, nhật ký, timer, phạm vi khoá) | Xong 2026-11-04, kiểm trong app Tauri thật; chưa có đường production tạo approval (Phase 4)       |
| Preset, phím tắt cơ bản, radio thẻ ngang           | Xong 2026-11-04, chỉ có test Vitest, chưa kiểm app Tauri thật                                     |
| 3 (quét CLI, `agy`, router)                        | Đang làm: adapter `agy` (CLI giả), router xong; còn Ollama, resource monitor, UI capability thiếu |
| 7C-2, 7D Tailwind/shadcn, E2E người dùng mới       | Chưa bắt đầu (7C-2 chờ Phase 4; Tailwind/shadcn chờ duyệt dependency)                             |
| `PHASE7_REPORT.md`                                 | Chỉ viết khi cả Phase 7 đạt tiêu chí đóng                                                         |

`claude`, `codex` chạy được task thật; `agy` (Antigravity 1.4.8) đã có adapter (thành công chỉ khi `num_turns` > 0 và `response` không rỗng) nhưng mới qua contract test với CLI giả, chưa chạy `agy` thật (còn 1 lượt probe cần người dùng cho phép). Gemini đã bỏ khỏi roadmap và khỏi README/CLAUDE.md.

## CI

- Commit `1009755`: đủ 5 job xanh (Security chạy khoảng 41 phút với bản quét cũ; bản quét mới chưa có số đo trên CI).
- `babca05` đỏ do Prettier lệch ở `docs/HANDOFF.md`; `868daef` (đã format lại) xanh đủ 5/5 job (2026-11-04). PR #1 đã merged nên không còn PR nào được ứng dụng theo dõi.
- `3d5925f`: TypeScript (ubuntu, windows), Tauri và một lượt Security (bản quét mới, lần đầu trên Linux) xanh; chưa đọc đủ kết luận các lượt còn lại.
- `1540a4f`: xanh cả 10 check run (2026-11-04). Security chạy 7,1 phút (push) và 5,9 phút (pull_request) với bản quét mới, so với khoảng 41 phút trước đó.
- `f75a72b`, `48ff83e`, `7275822`: chưa có kết luận (lần đọc gần nhất của `f75a72b`: TypeScript ubuntu xanh, các job khác còn chạy/xếp hàng). Việc đầu tiên: đọc lại bằng GraphQL.
- Đọc CI bằng GraphQL (`checkSuites`/`checkRuns`), không dùng `gh run view`/`gh run watch` (REST từng chạm trần 5000/giờ, trả 403).
- `3a9a85b` có chuỗi secret giả trong test. Nếu bộ quét báo, chỉ thêm đúng tuple đã rà soát vào danh sách chấp nhận của `scripts/secret-scan.py`, không nới lỏng bộ quét.

## Việc tiếp theo (theo thứ tự)

1. Đọc CI của `7275822` (và các commit trước); nếu Security đỏ do script, sửa `scripts/secret-scan.py`. Sau đó fast-forward nhánh gốc nếu xanh.
2. Phase 3 còn lại: UI capability thiếu (render `describeCapabilityGap` ở `apps/desktop`), nối router vào `workflows.start`, resource monitor; chạy `agy` thật qua adapter (xin phép lượt probe). Ollama hoãn (máy chưa cài).
3. Phase 7 còn lại: Tailwind/shadcn (cần duyệt dependency: pin ≥ 2 tuần, audit, license, `docs/REFERENCES.md`), kiểm preset/phím tắt trong app thật, E2E người dùng mới. Cập nhật `CLAUDE.md` (Tailwind/shadcn ghi "đã chốt" nhưng chưa có; trỏ ADR-005). 7C-2 và đóng Phase 7 chờ Phase 4.

## Chờ người dùng quyết

- Dọn A5 không làm mất dữ liệu người dùng: mục `index/claude.agent-studio` đã xoá là danh sách TÊN secret của provider claude do chính app tạo (`secrets.rs`), nhiều khả năng là tàn dư kiểm 7B; người dùng xác nhận chưa từng nhập secret nào. Không có mục thì Settings hiện danh sách rỗng (NoEntry → rỗng), không lỗi.
- Nhánh `claude/phase-2-kickoff-8a5732` là bản Phase 2 cũ, xung đột add/add; khuyến nghị không gộp.

## Chưa xác minh / nợ nhỏ

- 2026-11-04 (sau 7C-1): `pnpm lint`, `typecheck`, `test` (44 file, 389 test), `build` qua. Rust không đổi nên `cargo clippy`/`cargo test` chưa chạy lại (lần trước: clippy sạch, 12 test qua, 1 bỏ qua). `cargo audit` 0.22.2: không lỗ hổng; hai cảnh báo transitive (`proc-macro-error` không bảo trì, `glib 0.18.5` unsound).
- Đã kiểm trong app thật (2026-11-04): thẻ phê duyệt, Decision log, History (Older, giờ), sidebar hẹp, theme tối. B1 (resume Peer Review với CLI thật) đạt cả hai chiều claude↔codex.
- Timer hết hạn 5 giây chỉ được chứng minh bằng test đơn vị; trong app thật UI poll `approvals.list` (cũng gọi `expireDue`) nên chưa tách riêng được.
- Chưa kiểm trong app thật: Settings > Agents Save/Use defaults, Peer Review chạy CLI thật qua UI. Danh sách radio "What happened?" trong thẻ reconciliation xếp dọc, trông lỏng (chưa sửa).
- Secret có thể lọt vào log nếu CLI tự in môi trường của nó (redaction không bao phủ giá trị bị biến đổi).
- Test `git-worktrees` từng flaky một lần; `logs.search` (LIKE) chưa benchmark.

## Quy ước làm việc

- Trả lời tiếng Việt có dấu. Kiểm thử app chạy ngầm, không dùng chuột/bàn phím của người dùng.
- Spawn process bằng mảng đối số, `shell: false`. Worktree không phải sandbox. Task có side effect không xác minh được → `needs_reconciliation`, không tự retry.
- Method IPC mới cần sửa 4 chỗ: Zod variant (`contracts`), `case` trong `sidecar.ts`, `ALLOWED_METHODS` + test trong `src-tauri/src/lib.rs`, stub trong `apps/desktop/src/preview-sidecar.ts`.
- Push gộp theo lô vì Security chậm; chỉ push khi người dùng đồng ý.
