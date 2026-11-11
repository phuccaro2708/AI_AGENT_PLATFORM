# HANDOFF — đang ở đâu

Cập nhật 2026-11-11. File này chỉ ghi trạng thái hiện tại; lịch sử xem `git log`.

## Trạng thái

- Nhánh làm việc: `simplify/2026-11-11`, tách từ `claude/loving-lovelace-32lh71` tại `4edc7a5`. Chưa push, chưa ghép về nhánh chính.
- Nhánh chính cũ được giữ nguyên để so sánh và lấy lại mã khi cần.
- Đợt này đã gỡ: tài liệu kế hoạch/báo cáo phase, CI kiểm đồng bộ tài liệu, cổng tuổi dependency, Antigravity, Ollama, resource monitor, cổng quyền tự viết (PolicyGate, `policy-engine`, cổng MCP của Claude, adapter `codex app-server`). Quyết định: `docs/DECISIONS.md` ADR-010.

## Kết quả kiểm tra tại HEAD (máy Windows này, 2026-11-11)

- `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm build`: đạt.
- `pnpm test`: 645 đạt, 5 lỗi đã biết trước (`it.fails`), 1 bỏ qua, 0 đỏ.
- `cargo clippy --all-targets -- -D warnings`: đạt.
- `cargo test --locked`: 1 ca đỏ, `job_wrap::timeout_kills_the_tree_and_exits_124`. Nhóm test Job Object đã chập chờn từ trước đợt này; chưa điều tra.
- Chưa kiểm: chạy app thật (`tauri dev`) sau khi gỡ; chạy `claude`/`codex` thật không qua cổng quyền.

## Việc kế tiếp

Xem `docs/ROADMAP.md` (thứ tự) và `docs/TODO.md` (chi tiết).
