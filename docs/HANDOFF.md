# Bàn giao tiến độ

Cập nhật: 2026-11-04 (tối; nhánh làm việc ở `bfbe920`, nhánh gốc ở `868daef`). Nhật ký chi tiết theo thời gian nằm ở `docs/PROGRESS.md`; file này chỉ nêu trạng thái hiện tại để người tiếp quản đọc nhanh.

## Vị trí

- Nhánh gốc `claude/loving-lovelace-32lh71` (cũng là `origin/HEAD`) đã được fast-forward tới `babca05` (2026-11-04), khớp với `claude/repo-current-status-acfd51`; không còn khác biệt. PR #1 đã ở trạng thái MERGED (không cần đóng).
- Ứng dụng: **Agent Workspace** (Tauri 2 + React/Vite, sidecar Node orchestrator, SQLite/Drizzle, pnpm monorepo).
- Giữ nguyên `identifier` `dev.agentstudio.desktop`, gói `@agent-studio/*`, service Credential Manager `agent-studio` (đổi sẽ mất dữ liệu và secret đã lưu).

## Trạng thái các phase

| Phase                                        | Trạng thái                                        |
| -------------------------------------------- | ------------------------------------------------- |
| 0, 1                                         | Đóng (`PHASE0_REPORT.md`, `PHASE1_REPORT.md`)     |
| 2 Peer Review MVP                            | Đóng 2026-11-03, có ngoại lệ, tag `mvp-phase2`    |
| 7A (lịch sử task, reconciliation)            | Xong, kiểm trong app Tauri thật                   |
| 7B (project policy, cấu hình agent, secrets) | Xong, kiểm trong app Tauri thật                   |
| Quét CLI (`agents.scan`)                     | Đã gộp (`2380045`); chỉ phát hiện, chưa chạy task |
| Redaction secret                             | Xong (`3a9a85b`), chỉ che theo giá trị chính xác  |
| 7C, 7D, preset, E2E người dùng mới           | Chưa bắt đầu                                      |
| `PHASE7_REPORT.md`                           | Chỉ viết khi cả Phase 7 đạt tiêu chí đóng         |

Chỉ `claude` và `codex` chạy được task. `agy` (Antigravity 1.4.8) mới được phát hiện. Gemini đã bỏ khỏi roadmap và khỏi README/CLAUDE.md.

## CI

- Commit `1009755`: đủ 5 job xanh (Security chạy khoảng 41 phút với bản quét cũ; bản quét mới chưa có số đo trên CI).
- `babca05` đỏ do Prettier lệch ở `docs/HANDOFF.md`; `868daef` (đã format lại) xanh đủ 5/5 job (2026-11-04). PR #1 đã merged nên không còn PR nào được ứng dụng theo dõi.
- Đọc CI bằng GraphQL (`checkSuites`/`checkRuns`), không dùng `gh run view`/`gh run watch` (REST từng chạm trần 5000/giờ, trả 403).
- `3a9a85b` có chuỗi secret giả trong test. Nếu bộ quét báo, chỉ thêm đúng tuple đã rà soát vào danh sách chấp nhận của `scripts/secret-scan.py`, không nới lỏng bộ quét.

## Việc tiếp theo (theo thứ tự)

1. Phase 7: 7C (thẻ phê duyệt cho approval do orchestrator tạo; "Luôn cho phép trong phạm vi" cần Phase 4), 7D (Tailwind/shadcn, phím tắt; dependency mới phải pin ≥ 2 tuần, qua audit và license), preset, E2E người dùng mới.
2. Phase 3: probe thật `agy` (`--print` + `--output-format stream-json`), rồi `adapter-antigravity` + fixture + contract test. Ollama hoãn (máy chưa cài). Không bịa capability.

## Chờ người dùng quyết

- (Đã được phép, đã làm chưa push) `timeout-minutes: 30` cho job Security và quét lịch sử theo (blob, path) trong `scripts/secret-scan.py`; cần CI xác nhận.
- Nhánh `claude/phase-2-kickoff-8a5732` là bản Phase 2 cũ, xung đột add/add; khuyến nghị không gộp.
- Dọn (đã được phép nhưng công cụ chặn, cần người dùng tự chạy): xoá thư mục `D:\as7a-tmp` (358 mục, 24 MB, không tiến trình nào dùng) và credential thừa `index/claude.agent-studio` (`cmdkey /delete:"LegacyGeneric:target=index/claude.agent-studio"`). Không chạm credential `agent-studio` đang dùng.

## Chưa xác minh / nợ nhỏ

- 2026-11-04: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` đều qua (44 file, 383 test); `cargo clippy --all-targets -- -D warnings` sạch; `cargo test`: 12 qua, 1 bỏ qua.
- `cargo audit` chưa cài cục bộ (CI đã chạy).
- Secret có thể lọt vào log nếu CLI tự in môi trường của nó (redaction không bao phủ giá trị bị biến đổi).
- Test `git-worktrees` từng flaky một lần; `logs.search` (LIKE) chưa benchmark.

## Quy ước làm việc

- Trả lời tiếng Việt có dấu. Kiểm thử app chạy ngầm, không dùng chuột/bàn phím của người dùng.
- Spawn process bằng mảng đối số, `shell: false`. Worktree không phải sandbox. Task có side effect không xác minh được → `needs_reconciliation`, không tự retry.
- Method IPC mới cần sửa 4 chỗ: Zod variant (`contracts`), `case` trong `sidecar.ts`, `ALLOWED_METHODS` + test trong `src-tauri/src/lib.rs`, stub trong `apps/desktop/src/preview-sidecar.ts`.
- Push gộp theo lô vì Security chậm; chỉ push khi người dùng đồng ý.
