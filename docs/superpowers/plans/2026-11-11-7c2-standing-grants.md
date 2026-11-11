# 7C-2 "Luôn cho phép trong phạm vi" — kế hoạch (CHỜ NGƯỜI DÙNG DUYỆT)

> Trạng thái: **bản nháp, chưa được duyệt, chưa có dòng mã nào**. Vòng lặp tự động dừng tại đây (nguyên tắc: 7C-2 lập kế hoạch rồi hỏi lại, ADR-010). Chỉ làm khi người dùng duyệt phạm vi grant ở mục "Cần quyết".

**Mục tiêu:** người dùng bấm "Luôn cho phép trong phạm vi" ở thẻ phê duyệt thì lần hỏi tương tự sau đó được cho qua theo grant còn hiệu lực, có hết hạn, thu hồi được, và mọi quyết định nằm trong nhật ký.

**Kiến trúc:** Policy Engine đã có `applyGrants` và `grantTargetFor` (`packages/policy-engine/src/grants.ts`, có test). Bảng `approval_grants` và `ApprovalScope` đã có (migration 0006). Còn thiếu phần nối: `approvals.resolve` hiện từ chối mọi scope khác `once` (`services/orchestrator/src/approvals.ts:61-66`); `policy-gate.ts` chưa truyền grant còn hiệu lực vào `ctx.grants`; UI chưa có nút và chưa có chỗ thu hồi.

**Spec:** `docs/ASSUMPTIONS.md` mục "Phạm vi grant (7C-2)", `docs/PHASE_PLANS.md` P7-1, `docs/NEXT_PLAN.md` C9.

## Ràng buộc chung

- Fail-closed: scope không có target an toàn (`grantTargetFor` trả `null`, kể cả gốc ổ đĩa) thì từ chối scope, không hạ cấp âm thầm xuống `once`.
- Grant hết hạn, đã thu hồi, `expiresAt` không đọc được, hoặc `target` rỗng thì không có hiệu lực.
- `deny` của Policy Engine không bao giờ bị grant che; grant chỉ áp lên kết quả `ask`.
- Sửa IPC phải đủ 4 chỗ (contracts, sidecar, `lib.rs` + test của nó, `apps/desktop/src/api.ts`).
- Frontend không tự quyết gì; mọi thứ qua sidecar có policy.

## Cần quyết (chỉ người dùng trả lời được)

1. **Phạm vi nào được bật?** (a) chỉ `path` hẹp: đường dẫn con trong worktree của task (đề xuất, đã ghi "hẹp" ở NEXT_PLAN nhưng HANDOFF còn ghi chờ duyệt); (b) thêm `command`; (c) thêm `task`/`project` nhưng mặc định tắt.
2. **Thời hạn mặc định của grant:** đề xuất 24 giờ, tối đa 7 ngày, không có "vĩnh viễn".
3. **Grant mang theo qua task/workflow khác không?** Đề xuất: `path` và `command` gắn với project, không gắn task cũ.

## Review Focus (đầu vào dễ gây lỗi mà spec không nói)

- Đường dẫn grant dẫn tới junction/symlink ra ngoài worktree: phải dùng canonical path lúc áp dụng, không phải lúc lưu.
- Hai approval đồng thời cho cùng target: không tạo hai grant trùng, không race làm grant vượt hạn.
- Đồng hồ máy chỉnh lùi: grant không sống lâu hơn hạn thật quá mức cho phép.
- Thu hồi khi task đang chạy: lời xin quyền kế tiếp phải hỏi lại, không dùng bản cache.
- `deny` rồi `ask` cùng target: grant không đảo thứ tự ưu tiên.

## Nhiệm vụ

### Task 1: `approvals.resolve` ghi grant

- Sửa: `services/orchestrator/src/approvals.ts`, test `approvals.test.ts`.
- Test viết trước: scope `path` với target hợp lệ tạo đúng một dòng `approval_grants` có `expiresAt`; `grantTargetFor` trả `null` thì ném lỗi rõ và không ghi gì; scope ngoài danh sách đã duyệt bị từ chối; quyết định ghi vào nhật ký.
- Kiểm chứng: `pnpm --filter @agent-studio/orchestrator test` xanh.

### Task 2: áp grant trong `policy-gate`

- Sửa: `services/orchestrator/src/policy-gate.ts`.
- Test: grant còn hạn cho `ask` đổi thành allow; hết hạn/thu hồi thì vẫn `ask`; `deny` không đổi; target ngoài grant vẫn `ask`.
- Kiểm chứng: test gate xanh, test policy-engine không đổi.

### Task 3: IPC `grants.list` / `grants.revoke`

- Sửa đủ 4 chỗ IPC + test `lib.rs`; chạy `cargo clippy --all-targets -- -D warnings` và `cargo test --locked`.
- Kiểm chứng: test sidecar IPC (`sidecar-*.test.ts`) gọi được cả hai, thu hồi có hiệu lực ngay.

### Task 4: giao diện

- Sửa: thẻ phê duyệt (nút "Luôn cho phép trong phạm vi" chỉ hiện khi scope hợp lệ, hiện target và hạn), danh sách grant trong Settings kèm nút thu hồi.
- Kiểm chứng: test UI thuần + xem trong app Tauri thật (cách đã dùng ở PROGRESS 2026-11-11).

### Task 5: đóng 7C-2

- Cổng đầy đủ + Codex review chỉ đọc + ghi PROGRESS. Chỉ sau đó mới tính tới `PHASE7_REPORT.md`.

## Tự kiểm kế hoạch

Mỗi quyết định trong "Cần quyết" chặn Task 1 (scope/thời hạn quyết kiểu dữ liệu và test). Không có bước nào thêm dependency. Task 3 là chỗ duy nhất đụng `src-tauri`.
