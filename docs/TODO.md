# TODO

Việc còn mở, xếp theo thứ tự nên làm. Xong việc nào thì xoá dòng đó; lịch sử nằm trong `git log`.

## Cần làm trước

- [ ] Trong app thật, giao một task đơn cho `codex` (đã chạy: task đơn `claude` và lượt `claude` viết + `codex` review, 2026-11-12).
- [ ] Quyết định với task đơn giao cho `codex`: đo 2026-11-12 cho thấy `codex exec -s workspace-write` ghi được ra ngoài thư mục dự án (kể cả ngoài `%TEMP%`); `claude` thì không. Chọn: chấp nhận như ADR-010, chỉ cho codex chạy trong worktree, hoặc tìm cấu hình sandbox của codex chặn được (`docs/ASSUMPTIONS.md`, mục "Phạm vi ghi của task đơn").
- [ ] Chạy `scripts/batch-review.mjs` với một task nhỏ bằng CLI thật (vòng worktree → commit → review chưa chạy lần nào).

## Phần đã thành thừa, có thể gỡ tiếp

- [ ] Approvals: sau khi gỡ cổng quyền không còn mã nào tạo yêu cầu phê duyệt. Còn lại `approvals.ts`, method `approvals.list`/`approvals.resolve`, trạng thái `waiting_approval`, thẻ phê duyệt trong `PeerReviewView.tsx`, bảng `approvals`/`approval_grants`.
- [ ] `Scheduler`: tuỳ chọn `admission` và `setConcurrency` không còn ai gọi.
- [ ] `packages/process-manager/src/live-pids.ts` (`liveChildPids`) không còn ai gọi.
- [ ] `ClaudeAdapter`: tuỳ chọn `taskArgs` và `safeMode` chỉ phục vụ cổng đã gỡ; `describeLaunch` trong `agent-core` cũng vậy.
- [ ] `tests/contracts/fixtures/agy`: chỉ còn `help.txt`, `version.txt` được dùng (test quét CLI).
- [ ] `docs/ASSUMPTIONS.md` (716 dòng): các mục về agy, Ollama, VRAM, cổng quyền (P4-1, d3–d14) mô tả mã đã gỡ; còn trỏ tới file đã xoá (`PHASE_PLANS.md`, `PROGRESS`, `NEXT_PLAN.md`).
- [ ] `docs/PROTOCOL.md`, `DATABASE.md`, `SECURITY.md`, `ARCHITECTURE.md` còn nhắc "Phase n", approvals, `waiting_approval` (ví dụ `PROTOCOL.md` dòng cuối: "path/approval policy ... (Phase 4)"). Sửa cùng lúc với việc gỡ approvals.
- [ ] Worktree cũ còn trên máy: `.claude/worktrees/p4-close-prep` (còn `policy-engine`, `it.fails`), `roadmap-review-phases-416476`, `winapp-agentroom-check-f81031`. Người dùng quyết định dọn hay giữ.
- [ ] Chú thích trong mã còn nhắc "Phase n", "Policy Engine", "ADR-006".
- [ ] `scripts/secret-scan.py` cùng danh sách ngoại lệ: xem có còn đáng giữ cho công cụ cá nhân.
- [ ] Đổi tên `tests/contracts` (chỉ chứa fixtures) để khỏi nhầm với `tests/contract`.

## Nợ kỹ thuật đã biết

- [ ] Hai cảnh báo `pnpm audit` mức moderate (dev-only: esbuild qua drizzle-kit, minimatch qua eslint) và hai cảnh báo `cargo audit` (proc-macro-error không còn bảo trì, glib chỉ vào qua GTK trên Linux). Kiểm lại 2026-11-12: không có mức high/critical.
- [ ] `cargo fmt --check` báo khác biệt có sẵn trong `apps/desktop/src-tauri/src/lib.rs` (không nằm trong gate hay CI).
- [ ] Nút Browse…, Settings, theme, bố cục hẹp chưa kiểm trong app Tauri thật.
