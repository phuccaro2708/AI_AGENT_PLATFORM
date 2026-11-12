# HANDOFF — đang ở đâu

Cập nhật 2026-11-12. File này chỉ ghi trạng thái hiện tại; lịch sử xem `git log`.

## Trạng thái

- Nhánh làm việc: `simplify/2026-11-11`, tách từ `claude/loving-lovelace-32lh71` tại `4edc7a5`. Chưa push, chưa ghép về nhánh chính.
- Nhánh chính cũ được giữ nguyên để so sánh và lấy lại mã khi cần.
- Đợt này đã gỡ: tài liệu kế hoạch/báo cáo phase, CI kiểm đồng bộ tài liệu, cổng tuổi dependency, Antigravity, Ollama, resource monitor, cổng quyền tự viết (PolicyGate, `policy-engine`, cổng MCP của Claude, adapter `codex app-server`). Quyết định: `docs/DECISIONS.md` ADR-010.
- 2026-11-12: gộp hai chế độ Agent và Peer Review thành một ô soạn. Ô `Review` để `None` thì chạy task đơn (sửa thẳng thư mục dự án); chọn một reviewer thì chạy Peer Review (worktree). Đã bỏ thanh chuyển chế độ và Ctrl+1/Ctrl+2. Logic chặn nút Run nằm ở `startBlocker` (`apps/desktop/src/capabilityGap.ts`).
- 2026-11-12: thêm `scripts/batch-review.mjs`, chạy lô theo vòng Claude viết, Codex review, mỗi task một worktree và một nhánh `batch/<stamp>/<id>`. Mới thử bằng `--dry-run`.

## Kết quả kiểm tra tại HEAD (máy Windows này, 2026-11-12)

- `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm build`: đạt.
- `pnpm test`: 649 đạt, 5 lỗi đã biết trước (`it.fails`), 1 bỏ qua, 0 đỏ.
- `cargo clippy`, `cargo test`: không chạy lại đợt này (không đụng `src-tauri`). Lần chạy 2026-11-11: clippy đạt; `cargo test --locked` có 1 ca đỏ, `job_wrap::timeout_kills_the_tree_and_exits_124`. Nhóm test Job Object đã chập chờn từ trước đợt này; chưa điều tra.
- Ô soạn gộp đã kiểm trên bản xem trước Vite (preview sidecar giả): chọn reviewer thì nút thành "Run with review", ẩn Preset, khoá Auto; không lỗi console. Chưa bấm chạy thật.
- App thật (`tauri dev`, 2026-11-12) trên một repo demo: task đơn `claude` (Review None) sửa đúng file trong thư mục dự án, trạng thái completed. Lượt có reviewer (`claude` viết, `codex` review) chạy trong worktree riêng, codex trả approve ở vòng 1, workflow completed, diff hiện trong app; checkout chính không đổi, thay đổi nằm chưa commit trong worktree.
- Chạy dev cần `AGENT_STUDIO_SIDECAR_DIR` trỏ tới `services/orchestrator/sidecar-dist` (build bằng `node scripts/build-sidecar.mjs`). Mở thẳng `agent-studio.exe` không có biến này thì app báo "The background service could not start".
- Chưa kiểm: task đơn giao cho `codex`; agent có ghi ra ngoài thư mục dự án hay không.

## Việc kế tiếp

Xem `docs/ROADMAP.md` (thứ tự) và `docs/TODO.md` (chi tiết).
