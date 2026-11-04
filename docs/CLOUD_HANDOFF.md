# Chuyển sang Claude Cloud: việc cần làm

Cập nhật: 2026-11-04. Trạng thái dự án nằm ở `docs/HANDOFF.md`; file này chỉ nói về ranh giới giữa máy Windows của người dùng và môi trường cloud.

## Điều kiện trước khi chuyển

1. Nhánh `claude/repo-current-status-acfd51` đã được push lên GitHub (cloud chỉ thấy nội dung đã push) và PR #2 đã đọc CI.
2. Quyết định nhánh gốc: cloud bắt đầu từ nhánh đã push, nên ghi rõ trong brief phiên cloud là nhánh nào.
3. Không đưa secret, token hay đường dẫn máy cá nhân vào brief hoặc repo.

## Cloud KHÔNG có (phải chờ người dùng, trên máy Windows)

| Thứ                                                             | Hệ quả                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Windows + WebView2                                              | Không build/kiểm `pnpm tauri build --debug`, không kiểm UI bằng CDP trong app thật |
| CLI `claude`, `codex`, `agy` đã đăng nhập                       | Không chạy task thật, không probe `agy` lượt 3, không B1 resume với CLI thật       |
| Windows Credential Manager (service `agent-studio`)             | Không kiểm lưu/đọc secret thật (`secrets.rs`)                                      |
| Ollama                                                          | Chưa cài cả trên máy người dùng; hoãn                                              |
| Quyền duyệt: dependency mới (Tailwind/shadcn), lượt probe `agy` | Cần người dùng đồng ý bằng lời                                                     |

## Cloud LÀM ĐƯỢC (Linux, chỉ cần Node + pnpm)

- Mã thuần TypeScript có test: `packages/*`, `services/orchestrator`, `tests/contract` (dùng CLI giả `fake-agy.mjs`), UI qua Vitest.
- Chạy `pnpm install --frozen-lockfile && pnpm lint && pnpm exec prettier --check . && pnpm typecheck && pnpm test && pnpm build` (Rust/Tauri không bắt buộc trên cloud).
- Việc ứng viên:
  1. Nối capability router vào `workflows.start` (4 chỗ IPC nếu thêm method: Zod trong `contracts`, `case` trong `sidecar.ts`, `ALLOWED_METHODS` + test trong `src-tauri/src/lib.rs`, stub trong `preview-sidecar.ts`).
  2. Resource monitor (Phase 3), có test đơn vị.
  3. Phase 4 Policy Engine (thiết kế + mã thuần, có test), mở khoá 7C-2.
  4. Cập nhật `CLAUDE.md` (Tailwind/shadcn ghi "đã chốt" nhưng chưa có; trỏ ADR-005).
  5. E2E người dùng mới bằng Playwright với `preview-sidecar` (không cần CLI thật).
- Đọc CI bằng GraphQL (`statusCheckRollup`), không dùng `gh run watch`.

## Quy tắc giữ nguyên trên cloud

- Native CLI first, không bịa capability, spawn `shell:false`, báo cáo trung thực, mục chưa chạy ghi "chưa chạy".
- Giữ `identifier` `dev.agentstudio.desktop`, gói `@agent-studio/*`, service `agent-studio`.
- Phiên cloud chỉ chạm tập file riêng; không push nhánh gốc; không bật auto-merge.

## Việc người dùng cần làm lại trên máy Windows sau khi cloud xong

1. Fetch nhánh cloud, chạy lại kiểm chứng đầy đủ kể cả `cargo clippy -D warnings` và `cargo test` nếu `src-tauri` đổi.
2. Kiểm trong app Tauri thật mọi thay đổi UI của cloud.
3. Cho phép (hoặc không) lượt probe `agy` thứ 3 và duyệt dependency Tailwind/shadcn.
