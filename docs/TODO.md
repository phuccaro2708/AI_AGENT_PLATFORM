# TODO

Việc còn mở, xếp theo thứ tự nên làm. Xong việc nào thì xoá dòng đó; lịch sử nằm trong `git log`.

## Cần làm trước

- [ ] Trong app thật, giao một task đơn cho `codex` (đã chạy: task đơn `claude` và lượt `claude` viết + `codex` review, 2026-11-12).
- [ ] Kiểm với CLI thật: task đơn giờ chạy `workspace-write` ngay trong thư mục dự án (không có worktree). Xác nhận `claude` và `codex` sửa được file và không ghi ra ngoài thư mục đó.
- [ ] Chạy `scripts/batch-review.mjs` với một task nhỏ bằng CLI thật (vòng worktree → commit → review chưa chạy lần nào).
- [ ] Điều tra test Rust `job_wrap::timeout_kills_the_tree_and_exits_124` (đỏ 2026-11-11) và hai test Job Object phía Node từng đỏ rồi tự xanh.

## Phần đã thành thừa, có thể gỡ tiếp

- [ ] Approvals: sau khi gỡ cổng quyền không còn mã nào tạo yêu cầu phê duyệt. Còn lại `approvals.ts`, method `approvals.list`/`approvals.resolve`, trạng thái `waiting_approval`, thẻ phê duyệt trong `PeerReviewView.tsx`, bảng `approvals`/`approval_grants`.
- [ ] `Scheduler`: tuỳ chọn `admission` và `setConcurrency` không còn ai gọi.
- [ ] `packages/process-manager/src/live-pids.ts` (`liveChildPids`) không còn ai gọi.
- [ ] `ClaudeAdapter`: tuỳ chọn `taskArgs` và `safeMode` chỉ phục vụ cổng đã gỡ; `describeLaunch` trong `agent-core` cũng vậy.
- [ ] `tests/contracts/fixtures/agy`: chỉ còn `help.txt`, `version.txt` được dùng (test quét CLI).
- [ ] `docs/ASSUMPTIONS.md` (706 dòng): các mục về agy, Ollama, VRAM, cổng quyền (P4-1, d3–d14) mô tả mã đã gỡ.
- [ ] Chú thích trong mã còn nhắc "Phase n", "Policy Engine", "ADR-006".
- [ ] `scripts/secret-scan.py` cùng danh sách ngoại lệ: xem có còn đáng giữ cho công cụ cá nhân.
- [ ] Đổi tên `tests/contracts` (chỉ chứa fixtures) để khỏi nhầm với `tests/contract`.

## Nợ kỹ thuật đã biết

- [ ] `project-policy`: đường dẫn UNC kiểu administrative share lọt qua luật chặn thư mục hệ thống (2 test `it.fails` trong `sidecar-security.test.ts`).
- [ ] Hai cảnh báo `pnpm audit` mức moderate (dev-only) và hai cảnh báo `cargo audit` (chỉ vào qua GTK trên Linux).
- [ ] Nút Browse…, Settings, theme, bố cục hẹp chưa kiểm trong app Tauri thật.
