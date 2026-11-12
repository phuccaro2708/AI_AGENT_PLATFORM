# HANDOFF — đang ở đâu

Cập nhật 2026-11-12. File này chỉ ghi trạng thái hiện tại; lịch sử xem `git log`.

## Trạng thái

- Nhánh làm việc: `simplify/2026-11-11`, tách từ `claude/loving-lovelace-32lh71` tại `4edc7a5`. Đợt 2026-11-12 đẩy lên và mở PR #4 về `claude/loving-lovelace-32lh71`; chưa merge. CI tại `85ced13` (đọc 2026-11-12): TypeScript (ubuntu, windows), Rust, spike Windows đạt; job Security còn pending.
- Nhánh chính cũ được giữ nguyên để so sánh và lấy lại mã khi cần.
- Đợt này đã gỡ: tài liệu kế hoạch/báo cáo phase, CI kiểm đồng bộ tài liệu, cổng tuổi dependency, Antigravity, Ollama, resource monitor, cổng quyền tự viết (PolicyGate, `policy-engine`, cổng MCP của Claude, adapter `codex app-server`). Quyết định: `docs/DECISIONS.md` ADR-010.
- 2026-11-12: gộp hai chế độ Agent và Peer Review thành một ô soạn. Ô `Review` để `None` thì chạy task đơn (sửa thẳng thư mục dự án); chọn một reviewer thì chạy Peer Review (worktree). Đã bỏ thanh chuyển chế độ và Ctrl+1/Ctrl+2. Logic chặn nút Run nằm ở `startBlocker` (`apps/desktop/src/capabilityGap.ts`).
- 2026-11-12: đóng phần Phase 4 cũ còn hợp với ADR-010 (không khôi phục policy-engine hay approvals): từ chối thư mục dự án dạng UNC, giới hạn 1 MiB chữ cho mỗi sự kiện agent lưu vào DB (giữ nguyên các trường gốc như `type`, `callId`), làm phẳng mọi ký tự xuống dòng trên context board, sửa hai chỗ đua thời gian trong test Job Object, kiểm audit và đo phạm vi ghi của task đơn với CLI thật. Không còn test `it.fails`. Codex review độc lập 3 vòng; các phát hiện đều đã sửa.
- 2026-11-12: thêm `scripts/batch-review.mjs`, chạy lô theo vòng Claude viết, Codex review, mỗi task một worktree và một nhánh `batch/<stamp>/<id>`. Mới thử bằng `--dry-run`.

## Kết quả kiểm tra tại HEAD (máy Windows này, 2026-11-12)

- `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm build`: đạt.
- `pnpm test` tại `85ced13`: 666 đạt, 1 bỏ qua, 0 đỏ, 0 `it.fails`.
- `cargo clippy --all-targets -- -D warnings`: đạt. `cargo test --locked`: đạt hết; nhóm `job_wrap` chạy 5 lần liền đều xanh sau khi sửa đua thời gian (mỗi lần tra CIM mất khoảng 1 s, đua với timeout 3 s cũ).
- `pnpm audit`: không có mức high/critical (2 moderate dev-only). `cargo audit`: 2 cảnh báo đã cho phép.
- Ô soạn gộp đã kiểm trên bản xem trước Vite (preview sidecar giả): chọn reviewer thì nút thành "Run with review", ẩn Preset, khoá Auto; không lỗi console. Chưa bấm chạy thật.
- App thật (`tauri dev`, 2026-11-12) trên một repo demo: task đơn `claude` (Review None) sửa đúng file trong thư mục dự án, trạng thái completed. Lượt có reviewer (`claude` viết, `codex` review) chạy trong worktree riêng, codex trả approve ở vòng 1, workflow completed, diff hiện trong app; checkout chính không đổi, thay đổi nằm chưa commit trong worktree.
- Chạy dev cần `AGENT_STUDIO_SIDECAR_DIR` trỏ tới `services/orchestrator/sidecar-dist` (build bằng `node scripts/build-sidecar.mjs`). Mở thẳng `agent-studio.exe` không có biến này thì app báo "The background service could not start".
- Phạm vi ghi, đo bằng adapter thật: `claude` từ chối ghi ra ngoài thư mục dự án; `codex exec -s workspace-write` ghi được ra ngoài, kể cả ngoài `%TEMP%`. Đây là rủi ro ADR-002/010 đã chấp nhận, cần quyết định (xem `docs/TODO.md`).
- Chưa kiểm: task đơn giao cho `codex` từ giao diện app.

## Việc kế tiếp

Xem `docs/ROADMAP.md` (thứ tự) và `docs/TODO.md` (chi tiết).
