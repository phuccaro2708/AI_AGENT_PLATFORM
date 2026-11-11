# DECISIONS — các quyết định còn hiệu lực

Chỉ giữ quyết định đang chi phối mã hiện tại. ADR-003 đến ADR-009 (A2A, thứ tự phase, cầu nối DeepSeek, cổng quyền mặc định, codex app-server, agy) đã hết hiệu lực sau ADR-010; nội dung cũ xem bằng `git show 4edc7a5:docs/DECISIONS.md`.

## ADR-001: Orchestrator là sidecar Node của Tauri

- **Quyết định:** Orchestrator viết bằng TypeScript, chạy thành tiến trình sidecar do vỏ Tauri khởi động, nói chuyện qua NDJSON trên stdin/stdout. UI không bao giờ tự spawn CLI.
- **Đã kiểm:** chạy được ở `tauri dev` trên máy Windows này. Bản release/installer chưa kiểm và không còn trong phạm vi (ADR-010).

## ADR-002: Không có sandbox hệ điều hành

- **Quyết định:** Agent chạy với đúng quyền của người dùng. Lớp bảo vệ gồm: quyền/sandbox của chính CLI (`claude --tools`/`--permission-mode`, `codex -s`), Job Object để dọn cây tiến trình, allowlist biến môi trường, và kiểm tra thư mục dự án.
- **Hệ quả:** Git worktree là cách ly nhánh, **không phải** biên bảo mật. Không được mô tả sản phẩm là "an toàn với mã không tin cậy".

## ADR-010: Thu gọn thành công cụ cá nhân (2026-11-11)

- **Bối cảnh:** Sau 10 ngày, repo có 11 phase, 5 file kế hoạch chồng nhau, khoảng 3.800 dòng tài liệu và nhiều lớp bảo vệ tự viết, trong khi người dùng duy nhất là tác giả và chưa dùng app cho việc thật. Gate cục bộ đã đỏ sẵn; CI sẽ đỏ theo ngày vì danh sách ngoại lệ tuổi dependency hết hạn.
- **Quyết định (người dùng chọn):**
  1. Mục tiêu là công cụ cho riêng một người. Bỏ installer, ký mã, auto-update, ACP, MCP gateway, lập lịch, mục tiêu "ngang AionUi".
  2. Chỉ giữ hai agent: Claude Code và Codex. Gỡ Antigravity, Ollama và resource monitor (CPU/RAM/VRAM).
  3. Gỡ cổng quyền tự viết (PolicyGate, `policy-engine`, cổng MCP `--permission-prompt-tool`, adapter `codex app-server`). Quyền do CLI tự thực thi qua cờ mà adapter truyền.
  4. Task đơn chạy với `workspace-write` ngay trong thư mục dự án, không qua worktree: agent sửa thẳng file của người dùng. Muốn có bản nháp tách riêng thì dùng Peer Review.
  5. Bỏ hệ thống phase/gate/báo cáo. Tài liệu trạng thái còn `ROADMAP`, `TODO`, `HANDOFF`; nhật ký là `git log`.
- **Cái mất đi, nói thẳng:**
  - Không còn kiểm tra trước khi chạy (thư mục, chương trình) và không còn kiểm tra sau khi chạy "có ghi ngoài phạm vi được cấp không" cho task đơn. Peer Review vẫn tự so worktree trước/sau lượt review.
  - Không còn hỏi người dùng theo từng lệnh/từng file. CLI chạy không tương tác tự quyết theo cờ quyền.
  - Không còn giảm số task khi máy quá tải; trần cố định 2 task cùng lúc.
- **Chưa kiểm:** hành vi của `claude`/`codex` thật khi chạy không qua cổng (chỉ có test với adapter giả).
- **Lấy lại khi cần:** mã cũ ở nhánh `claude/loving-lovelace-32lh71` (commit `4edc7a5`). Xem lại quyết định này nếu công cụ được đưa cho người khác dùng hoặc chạy trên repo không tin cậy.
