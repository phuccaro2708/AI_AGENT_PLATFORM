# PHASE 2 REPORT

Nhánh `claude/repo-current-status-acfd51`. Các bước 1–8 đã commit; bước 9 (e2e thật + báo cáo) là bản này.

**Kết luận: PHASE 2 ĐÓNG (2026-11-03), có ngoại lệ ghi rõ.** Đường găng Peer Review (implement → review) chạy thật với Claude 2.1.316 và Codex 0.165.0 qua sidecar, không copy tay. Các ngoại lệ không bị che nằm ở cuối.

## Acceptance gate (ROADMAP.md)

| Tiêu chí                                                             | Trạng thái           | Bằng chứng / lý do                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow thật "implement → review" không copy tay                    | **ĐẠT, có giới hạn** | `node scripts/e2e-peer-review.mjs run claude codex`: workflow `completed` sau 43 s; Claude (implementer, ghi `hello.txt` trong worktree riêng) → Codex (reviewer, đọc worktree) → `review.result`; diff chứa `+hello`; checkout chính sạch; bảng ngữ cảnh có `goal`, `artifact`. Chạy qua `SidecarService` thật, **chưa** bấm qua UI trong app Tauri                                             |
| Kill giữa chừng → restart không mất message, duplicate xử lý an toàn | **ĐẠT, có giới hạn** | `... kill claude codex`: SIGKILL tiến trình đang chạy implementer thật; restart trên cùng DB → task `needs_reconciliation`, 2 message đã commit còn nguyên, không chạy lại sau 3 s. Duplicate/crash của router: test fault-injection `router.test.ts` (adapter giả). Giới hạn: workflow vẫn `running` sau restart (engine chưa resume), không có tiến trình `claude` mồ côi nào được kiểm cụ thể |
| 2 agent song song trên 2 worktree không ghi đè nhau                  | **ĐẠT**              | `... two claude codex`: hai workflow cùng project, 2 worktree khác nhau, diff `one.txt`/`two.txt` không lẫn, cả hai `completed`, checkout chính sạch. Ghi chú: cùng cặp agent, hai workflow chạy với concurrency scheduler mặc định 2                                                                                                                                                            |
| Task side-effect không rõ → `needs_reconciliation`, không auto-retry | **ĐẠT**              | Test scheduler/orchestrator (`executions` = 1 sau lease hết hạn/restart) và lần kill thật ở trên                                                                                                                                                                                                                                                                                                 |
| Gán vai; agent chỉ nhận phần bảng được thấy (test)                   | **ĐẠT**              | `context-board.test.ts`, `workflow-engine.test.ts` (reviewer chỉ thấy `goal`+`artifact`, implementer `goal, plan, decision`); e2e thật cho thấy board có đúng các loại mục                                                                                                                                                                                                                       |

## Kiểm tra tự động (2026-11-03)

| Lệnh                                                           | Kết quả                                              |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm lint` / `pnpm format` / `pnpm typecheck` / `pnpm build`  | pass                                                 |
| `pnpm test`                                                    | 31 file, 284 test pass, 0 skip                       |
| `cargo test --locked` (src-tauri)                              | 7 pass                                               |
| `cargo clippy --locked -- -D warnings`                         | sạch                                                 |
| `node scripts/e2e-peer-review.mjs run\|kill\|two claude codex` | 3/3 exit 0 (CLI thật; tốn token, không chạy trên CI) |

CI GitHub: lần chạy đầu (`64532f8`) đỏ vì (1) `scripts/build-sidecar.mjs` thiếu alias `git-worktrees`, (2) `samePath` sai trên Windows do thư mục temp dùng tên 8.3 (đã sửa ở `5d8a92a`, `8789e93`), rồi (3) secret scan báo giả tên nhánh giả trong test (đã duyệt tay, `c74b924`). **Run `41690761288` ở `c74b924`: 5/5 job xanh** (Security mất ~32 phút vì quét 83 commit).

## Đối chiếu từng hạng mục ROADMAP Phase 2

| Hạng mục ROADMAP                                                             | Trạng thái                    | Ghi chú                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| Durable Message Router (outbox/inbox, ack, dedupe, retry, DLQ, backpressure) | Xong                          | `router.test.ts` (fault injection, adapter giả)                          |
| Transaction state + outbox                                                   | Xong                          | `Repo.tx`                                                                |
| Task DAG + scheduler (priority, dependency, lease, concurrency 2)            | Xong, có giới hạn             | concurrency chưa từ settings; chưa có IPC `createDag`                    |
| `packages/git-worktrees`                                                     | Xong                          | CI Windows đã bắt một lỗi đường dẫn 8.3 và đã sửa                        |
| Workflow engine: Supervisor + Peer Review + Parallel Workers                 | **Một phần: chỉ Peer Review** | Supervisor/Parallel Workers dời Phase 9 (rủi ro R9)                      |
| Handoff Claude implement → Codex review                                      | Xong                          | e2e thật 43 s                                                            |
| Vai cho agent                                                                | Xong                          | chưa có IPC `roles.upsert`                                               |
| Bảng ngữ cảnh chung + lọc theo vai                                           | Xong                          | có test                                                                  |
| Artifact registry, Diff Viewer, Message Timeline                             | Xong                          | UI chưa kiểm trong app Tauri                                             |
| Approval Center cơ bản (`approvals.resolve`)                                 | **Một phần**                  | không có đường production tạo approval; chưa timer expiry                |
| Ngoài ROADMAP nhưng đã làm                                                   |                               | Peer Review UI thay chế độ multi-agent giả; restore run qua `tasks.list` |

## Ngoại lệ và nợ (chuyển sang phase sau, xem ASSUMPTIONS.md)

- Chưa chạy luồng này qua UI trong app Tauri; UI Peer Review chỉ được kiểm bằng typecheck/build/test logic.
- Engine không resume sau restart: task bị gián đoạn → `needs_reconciliation` nhưng workflow ở `running`, người dùng chưa có UI giải quyết reconciliation (Phase 7).
- Supervisor và Parallel Workers chưa làm (R9); chỉ Peer Review.
- Approval từ CLI thật chưa quan sát; Approval Center đã nối `approvals.list/resolve` nhưng **chưa có đường production nào tạo approval** (`ApprovalService.request` chỉ được gọi trong test), nên khi chạy thật nó luôn rỗng. Chưa có timer hết hạn.
- Quyền theo vai: cờ CLI + cwd + kiểm tra sau chạy (phát hiện, không ngăn). Ánh xạ tool ghi của Claude và read-only của Codex mới được thấy hoạt động trong một lần chạy đơn giản; chưa thử đối kháng. Worktree không phải sandbox.
- Spike S4 (hủy khi đang ghi), perf-baseline sau bước 3 (R11), concurrency theo settings, `createDag`/`roles.upsert` IPC: chưa làm.
- Chi phí chạy thật không đo chính xác (prompt rất ngắn, repo tạm).
