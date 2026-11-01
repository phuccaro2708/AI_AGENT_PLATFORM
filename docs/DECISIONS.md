# DECISIONS — Architecture Decision Records

## ADR-001: Orchestrator là Tauri sidecar, đóng gói sẵn Node runtime

- **Trạng thái:** Đã chốt. Spike đã chạy trên runner Windows của GitHub (chưa xác minh trên máy Windows vật lý) — xem [`ADR-001.md`](ADR-001.md)
- **Bối cảnh:** Ứng dụng desktop cho người dùng cuối; không nên bắt họ cài Node. Orchestrator dùng TypeScript để chia sẻ types với UI.
- **Quyết định:** Đóng gói orchestrator (bundle JS) cùng Node runtime làm sidecar của Tauri. Dev mode dùng Node hệ thống theo `.nvmrc`.
- **Rủi ro chưa kiểm chứng:** native module (`better-sqlite3`, `node-pty`) có prebuild cho Windows x64 và đóng gói được vào sidecar hay không; kích thước installer.
- **Xem lại nếu:** spike Phase 0 thất bại → ghi ADR mới và chọn phương án khác (vd. Node SEA, `node:sqlite`); chưa khẳng định phương án nào hoạt động.

## ADR-002: Mức cô lập cho 1.0

- **Trạng thái:** Đã chốt
- **Quyết định:** 1.0 dùng Windows Job Object + Policy Engine (path/command/network) + allowlist executable và biến môi trường + sandbox của chính từng provider CLI. AppContainer / Windows Sandbox chỉ là spike đánh giá ở Phase 4, kết quả ghi vào `SECURITY.md`, không cam kết trong 1.0.
- **Hệ quả:** Tài liệu và UI phải nêu rõ đây **không phải** OS-level sandbox; approval không thay thế sandbox; Git worktree không phải biên bảo mật.
- **Xem lại nếu:** spike cho thấy AppContainer/Windows Sandbox khả thi với chi phí chấp nhận được.

## ADR-003: A2A gateway để sau 1.0 (v1.1)

- **Trạng thái:** Đã chốt
- **Bối cảnh:** MVP chỉ chạy trên một máy; giao thức nội bộ typed đủ dùng. A2A cần compatibility test đúng phiên bản spec.
- **Quyết định:** 1.0 chỉ có giao thức nội bộ + MCP gateway tối thiểu. A2A gateway làm ở v1.1. Message nội bộ đã có `correlationId`/`causationId` để map sau.
- **Ràng buộc:** không gọi hệ thống là "A2A-compatible" trước khi qua compatibility tests.
