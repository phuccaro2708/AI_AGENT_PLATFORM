# Kế hoạch tiếp theo

Nội dung đã chuyển sang `docs/PHASE_PLANS.md` (kế hoạch theo phase, lane, wave và danh sách quyết định). File này chỉ giữ lại để các liên kết cũ không gãy.

Tình trạng các bước của bản cũ (soạn 2026-11-05):

- Bước 2A (policy-engine trên Windows): xong, `327eab9`.
- Bước 3 (nối resource monitor vào sidecar): xong, `9e460a2` (còn `trackedPids`, VRAM, UI, cấu hình).
- Bước 4 (test flaky): phần scheduler xong (`34a066c`, lỗi nằm ở test); `process-manager` abort chưa tái hiện.
- Bước 2B: phần 1 (probe quyền thật) xong, `5866c85`; phần nối `evaluate()` chưa làm.
- Bước 0 (đọc CI) và Bước 1 (xem Auto/`agy` trong app thật): còn mở.

## Quyết định của người dùng (2026-11-05, trả lời từng câu của `PHASE_PLANS.md`)

| Mục                             | Quyết định                                                                                       | Việc kiểm chứng còn lại                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Probe vòng quyền (P4-1 c/d)     | Duyệt cả ba: `--permission-prompt-tool` của claude, app-server/MCP của codex, cờ sandbox của CLI | Chạy trong thư mục tạm, không bỏ qua quyền; ghi `ASSUMPTIONS.md` + fixture. Chưa chạy.                      |
| Phạm vi grant 7C-2 (P7-1)       | Hẹp: đường dẫn con trong worktree                                                                | Cần P4-1 xong; test hết hạn/thu hồi.                                                                        |
| Ngưỡng tài nguyên, concurrency  | Lưu trong settings, sửa ở Settings                                                               | Thêm method IPC: đủ 4 chỗ + `cargo`; không vượt trần `concurrency`.                                         |
| Ollama và VRAM (P3-1, P3-3)     | Cài Ollama, probe thật, đo VRAM bằng `nvidia-smi`                                                | Đã kiểm: `nvidia-smi` thấy RTX 5060 Laptop, 8151 MiB; Ollama CHƯA có trong PATH (người dùng cài/tải model). |
| Probe `agy` lần 3 (P3-6)        | Cho phép                                                                                         | Task nhỏ, chỉ đọc, thư mục tạm. Chưa chạy.                                                                  |
| Dependency                      | Duyệt Tailwind + shadcn và Playwright; CHƯA duyệt `node-pty`                                     | Mỗi gói: license, audit, pin chính xác ≥ 2 tuần, `REFERENCES.md`. Chưa chọn phiên bản.                      |
| Job Object (P4-4)               | Rust đặt sidecar vào Job Object                                                                  | `cargo clippy`/`cargo test` + đo thật trên Windows; không gọi là sandbox.                                   |
| AppContainer (P4-5)             | Chỉ tài liệu hoá vào `SECURITY.md`                                                               | Ghi rõ phần chưa đạt.                                                                                       |
| Audit và ghim Actions theo SHA  | Làm trong Phase 4                                                                                | `pnpm audit`, `cargo audit`, kiểm tuổi crate.                                                               |
| Security test, soak             | Agent giả trong CI + chạy tay CLI thật                                                           | Lượt CLI thật không đưa vào CI.                                                                             |
| Xem Auto/`agy` trong app (P0-2) | Gửi thêm một task thật                                                                           | Cần claude/codex đã đăng nhập; kiểm: tắt `agy` thì task không chạy bằng `agy`.                              |
| Nhánh và worktree               | Xoá worktree đã ghép và nhánh thiếu/cũ, nhưng kiểm tra và push trước                             | Xem bên dưới.                                                                                               |

Chưa hỏi/chưa quyết: việc push mọi commit và mở PR (chỉ làm khi người dùng yêu cầu rõ).

### Kết quả dọn nhánh/worktree

- Đã kiểm trước khi xoá: 6 worktree đều sạch (không thay đổi chưa commit); 4 nhánh phiên con đã ghép đủ vào nhánh chính (0 commit riêng).
- `claude/fix-pm-abort-flaky-7e3a1f` (1 commit riêng, chỉ ghi chú): đã push lên origin (`cf97850`) trước khi xoá nhánh local. `phase-2-kickoff-8a5732` (49167f6) và `repo-current-status-acfd51` (2826397) đã có sẵn trên origin cùng SHA.
- Đã xoá 7 nhánh local; origin vẫn giữ `fix-pm-abort-flaky`, `phase-2-kickoff`, `repo-current-status`. Git đã gỡ đăng ký cả 6 worktree.
- Cập nhật sau khi người dùng cho phép xoá: đã xoá `fix-pm-abort-flaky-7e3a1f` và `repo-current-status-acfd51`. Còn 4 thư mục RỖNG (`flaky-root-cause`, `policy-win-hardening`, `probe-permissions`, `wire-resource-monitor`) bị một tiến trình khác giữ ("being used by another process"); nhiều khả năng là phiên con tương ứng còn mở với thư mục đó làm cwd (chưa xác minh). Cần đóng/lưu trữ các phiên con đó rồi xoá lại.
- Ghi chú gốc (trước khi cho phép xoá): 6 thư mục worktree vẫn còn trên đĩa (`.claude/worktrees/*`) vì `git worktree remove` báo "Filename too long" / "Permission denied". Lệnh xoá cưỡng bức bằng robocopy bị chặn nên chưa thử lại. Cần người dùng cho phép hoặc tự xoá.

## Quyết định ngày 2026-11-05, đợt 2 (kế hoạch Phase 4 phần còn lại, đã duyệt)

| Mục          | Quyết định                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| P4-1 (c)/(d) | Probe cả ba trong thư mục tạm, không bỏ qua quyền; ghi ASSUMPTIONS + fixture; DỪNG báo người dùng, không viết mã tích hợp |
| P4-2         | Dựa vào log CI Windows; không dùng fsutil                                                                                 |
| P4-4         | Job Object cấp sidecar (Rust) và cấp task (binary phụ); không gọi là sandbox                                              |
| P4-5         | Chỉ tài liệu hoá AppContainer vào `SECURITY.md`                                                                           |
| P4-6         | Nối `diagnostics.export` thành method IPC (đủ 4 chỗ + `cargo`) và nút Settings                                            |
| P4-7         | Rà capabilities, xoá quyền thừa, giữ `ALLOWED_METHODS`; không WebSocket                                                   |
| P4-8         | Tách: recovery 5 bước + UI trước; resume Peer Review sau                                                                  |
| P4-11        | Chấp nhận có lý do hai cảnh báo moderate dev-only và hai transitive; nâng khi có bản vá ≥ 2 tuần                          |
| Ghép/push    | Ghép và push khi 5 gate (và `cargo`) xanh trên bản ghép                                                                   |
