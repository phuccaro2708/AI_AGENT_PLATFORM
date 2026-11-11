# ROADMAP — Agent Workspace

Phạm vi (chốt 2026-11-11, ADR-010): **công cụ cá nhân**, một người, một máy Windows, hai agent **Claude Code** và **Codex**. Không còn hệ thống phase, gate hay báo cáo phase; lộ trình là danh sách ngắn dưới đây, làm từ trên xuống.

## Đã có (kiểm bằng test tại HEAD, không phải bằng tài liệu)

- Vỏ Tauri 2 + sidecar Node nói chuyện qua NDJSON, allowlist method ở phía Rust.
- Chạy task đơn với `claude` hoặc `codex`, log theo luồng, huỷ task (kill cả cây tiến trình), lịch sử.
- Peer Review: implementer làm trong Git worktree riêng, reviewer chỉ-đọc; reviewer mà ghi file thì kết quả bị huỷ.
- Phát hiện CLI trên máy, lưu cấu hình khởi chạy sau khi probe, secrets trong Windows Credential Manager, che secret trong log và DB.
- Khôi phục sau khi tắt đột ngột: task dở chuyển `needs_reconciliation`, người dùng chọn làm lại hay bỏ.

## Việc tiếp theo

1. **Dùng thật mỗi ngày.** Chạy `tauri dev`, giao 5–10 task thật cho cả hai CLI, ghi lại chỗ vướng vào `docs/TODO.md`. Mọi việc sau đây xếp lại theo những gì bước này tìm ra.
2. **Quyền mặc định của task đơn.** Hiện task đơn không truyền cờ quyền nên CLI dùng mặc định của nó (Claude từ chối ghi khi chạy không tương tác, Codex chỉ-đọc). Quyết định có cho ghi vào thư mục dự án hay không.
3. **Gỡ tiếp phần đã thành thừa** (danh sách trong `docs/TODO.md`): approvals, tuỳ chọn không còn ai dùng, chú thích cũ.
4. **Giao diện.** Chỉ sửa những gì bước 1 cho thấy gây khó dùng.

## Đã loại khỏi phạm vi

Installer, ký mã, auto-update, ma trận tương thích CLI, ACP, MCP gateway, Skills, lập lịch, điều khiển từ xa, Supervisor/worker song song, sandbox hệ điều hành, Ollama, Antigravity, cổng quyền tự viết. Lý do và cách lấy lại: ADR-010. Mã cũ nằm ở nhánh `claude/loving-lovelace-32lh71`.
