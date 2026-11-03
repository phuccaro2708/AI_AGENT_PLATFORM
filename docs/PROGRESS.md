# Nhật ký tiến trình

Ghi theo thứ tự thời gian; số liệu lấy từ lịch sử git và các báo cáo phase. Đây là nhật ký, không thay `PHASEn_REPORT.md` (báo cáo đóng phase). Cập nhật lần cuối: 2026-11-03.

## Tổng quan

| Phase             | Trạng thái                                                                                                                                                                            | Bằng chứng                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 0                 | Đóng                                                                                                                                                                                  | `docs/PHASE0_REPORT.md`    |
| 1                 | Đóng 2026-11-02 (CI xanh run 41551598060)                                                                                                                                             | `docs/PHASE1_REPORT.md`    |
| 2 Peer Review MVP | Đóng 2026-11-03, có ngoại lệ, tag `mvp-phase2`                                                                                                                                        | `docs/PHASE2_REPORT.md`    |
| 7A                | Code và test xong, đã push (`eb80d83`), CI xanh 5 job; còn kiểm UI trong app Tauri thật                                                                                               | commit `428b422`…`eb80d83` |
| 7B                | Code và test xong, đã push (`7b8cb23`); CI đỏ ở `7b8cb23` (Security, 3 test Windows), kiểm app Tauri thật đạt có một lỗi probe; cả ba đã sửa ở `52660f3`, CI của commit này đang chạy | commit `ea4c183`…`7b8cb23` |
| 7C, 7D            | Chưa bắt đầu (7C cần nguồn approval từ Phase 4)                                                                                                                                       | `docs/TODO.md`             |

## 2026-11-02 — Phase 0–1

- Phase 0 và Phase 1 đóng; CI đủ 5 job xanh (`63d7ef5`, `b8a102c`).

## 2026-11-03 — Phase 2 (9 bước)

Router bền vững, DAG + scheduler với lease, `git-worktrees`, workflow engine Peer Review với vai và bảng ngữ cảnh, approval và artifact, IPC, UI Peer Review, e2e với Claude/Codex thật, `PHASE2_REPORT.md`. Quy tắc giữ nguyên: task đang chạy mà lease hết hạn hoặc crash → `needs_reconciliation`, không tự retry.

## 2026-11-03 — 7A (nợ Phase 2, lịch sử task)

- `tasks.history`, `logs.search`, `tasks.resolveReconciliation`, engine resume sau restart, tab History, thẻ "Needs your decision".
- e2e resume với claude → codex đã chạy thật.

## 2026-11-03 — 7B (6 bước)

1. `ea4c183` policy cho `projects.rootPath` (tồn tại, canonical, không quá rộng, không trùng).
2. `a104af8` chọn thư mục là lệnh native; webview mất quyền dialog.
3. `998ba7f`, `fce54cb` cấu hình agent theo provider (command/args/env), chỉ lưu sau probe có capability thật; args denylist, env allowlist; migration `0005`.
4. `63d07e7` secrets trong Windows Credential Manager, webview chỉ ghi/xóa/liệt kê tên, tiêm vào sidecar khi spawn theo provider, đổi secret thì restart sidecar (từ chối khi còn task).
5. `6461cf2` UI Settings → Agents (Check/Save/Use defaults, mục Secrets).
6. `7b8cb23` cập nhật ASSUMPTIONS, ROADMAP, TODO. Đã push.

Kiểm: lint, typecheck, 357 test, build, prettier; `cargo test` 12 qua + 1 bỏ qua (Credential Manager thật, chạy tay với `--ignored` đã qua), clippy sạch.

## Việc mở

- Kiểm 7A và 7B trong app Tauri thật (session `tauri-7b-check` đang làm 7B).
- CI của `7b8cb23` (session `ci-watch-7b`).
- `cargo audit` chưa cài; `keyring-core` 1.0.1 mới 21 ngày tuổi.
- Secret có thể lọt vào log task nếu CLI tự in môi trường của nó.
- Test `git-worktrees` từng flaky một lần; `logs.search` (LIKE) chưa benchmark.
- 7C Approval UI, 7D Tailwind/shadcn + phím tắt, rồi `PHASE7_REPORT.md`.

## 2026-11-03 (tối) — Đối chiếu roadmap, CLI mà app quét

- Kiểm: lint, typecheck, 358 test qua. CI của `52660f3` (run `41736953160`): 4 job xanh; job Security (bước secret scan, bắt đầu 23:10:16Z) chạy hơn 45 phút, chưa đọc được kết quả vì GitHub API trả 403 (nhiều bộ theo dõi dùng chung hạn mức). `da9614c` và `803ccac` chưa push.
- App không quét "model" LLM. Nó chỉ dò **CLI agent** có thật trên máy qua `agents.detect`/`agents.probe`: `claude` và `codex` (Gemini CLI và Ollama thuộc Phase 3, chưa có code). Mỗi CLI được ghi: đường dẫn, version, bảng capability suy từ `--help` (kể cả cờ `--model` của Claude, chỉ là cờ có mặt, không có danh sách model).
- Trên máy này: `claude` 2.1.316 (`~\.local\bin\claude.exe`), `codex-cli` 0.165.0 (npm shim `codex.cmd`); không có `gemini`, `ollama`. Khớp với ASSUMPTIONS #13/#14 (Claude 2.1.316 và 2.1.314, Codex 0.165.0).

## Đổi tên hiển thị

- Tên hiển thị của app đổi từ "Agent Studio" sang "Team workspace" (`cb1ed4d`), rồi chốt là **"Agent Workspace"** và đồng bộ ở giao diện (productName, tiêu đề cửa sổ, `index.html`, Header, About, thông báo) lẫn tài liệu (README, CLAUDE.md, docs/). Giữ nguyên `identifier` `dev.agentstudio.desktop`, tên package `@agent-studio/*` và service Credential Manager `agent-studio`, vì đổi chúng sẽ làm mất dữ liệu và secret đã lưu của người dùng hiện có.
