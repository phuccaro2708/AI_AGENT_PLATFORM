# PHASE 4 REPORT — Security & Reliability

Nhánh: `claude/winapp-agentroom-check-f81031` (đã ghép `worktree-p4-close-prep`). Ngày: 2026-11-10.

**Trạng thái: CHƯA ĐÓNG.** Báo cáo này chỉ ghi bằng chứng; việc đóng Phase 4 là quyết định của người dùng (ADR-010, CLAUDE.md nguyên tắc 10). Không tick gate nào trong `docs/ROADMAP.md` khi chưa có người dùng xác nhận.

## Hạng mục đã làm trong đợt này (ADR-010, ADR-011)

| #   | Hạng mục                        | Kết quả (lệnh thật, chi tiết ở `docs/PROGRESS.md` và `docs/ASSUMPTIONS.md`)                                                                                                                                                          |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Security CI bị huỷ              | Nguyên nhân: `timeout-minutes: 30`, không có `concurrency`; bước chậm chưa đo. Phiên con chỉ đọc (GraphQL). Không sửa workflow (file được bảo vệ).                                                                                   |
| 2   | NSIS/WiX                        | Người dùng duyệt; cài NSIS 3.13 qua winget, hash xác minh, `makensis /VERSION` = v3.13. WiX không cài.                                                                                                                               |
| 3   | `keepAlive` ngắn khi bật VRAM   | Test viết trước, đỏ rồi xanh; `keepAlive` là hàm đọc mỗi lượt chat; 30 s (giả định, chưa đo trên Ollama thật).                                                                                                                       |
| 4   | Probe lại cổng quyền claude     | claude 2.1.319, `askEveryTool`: 8/8 lời gọi (6 tool) tới cổng; 2 Bash bị chính sách từ chối.                                                                                                                                         |
| 5   | ADR-006 A1/A7/A8                | A8 ghim bằng test (hai `workflows.start` giống hệt → hai task riêng, không dedupe/retry ngầm), test pass. A1 chốt, không cần mã. A7 duyệt nguyên tắc nhưng CHƯA có mã (chưa có tích hợp Harness để bật).                             |
| 6   | C1/C5 với CLI thật, có giới hạn | Soak 5 workflow (trần cứng của bộ test) với claude/codex thật: 1 test pass, 184,8 s; 5/5 `completed`; 0 CLI mồ côi sau từng workflow và sau `svc.close()`. Bảng số liệu ở ASSUMPTIONS. KHÔNG chạy 100 workflow thật (đã thoả thuận). |
| 7a  | Probe `agy` lần 3               | agy 1.5.3 (trước 1.4.8): 6/6 pass, 72,8 s, 0 `agy.exe` còn lại. Hình dạng sự kiện không đổi. Ngoài gate (ADR-009).                                                                                                                   |
| 7b  | Dọn thư mục worktree rỗng       | Liệt kê, người dùng xác nhận, `rmdir` 8 thư mục rỗng không đăng ký. Giữ `int` và `...-loop-worktrees`.                                                                                                                               |
| 8   | Installer thật                  | `pnpm tauri build --bundles nsis --ci`: thoát 0, `Agent Workspace_0.0.0_x64-setup.exe` 2,42 MiB (SHA256 `374fa8ac…67ea`). Chưa ký, chưa chạy cài đặt/gỡ.                                                                             |

## Cổng cuối (chạy 2026-11-10 trên nhánh này)

| Lệnh                                   | Kết quả                                                                                                                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                            | PASS (exit 0)                                                                                                                                                                                             |
| `pnpm format`                          | **FAIL exit 1, nguyên nhân đã biết:** 29 file đều dưới `.superpowers/` (không theo dõi, git-ignored). Không file nào của repo bị cảnh báo. Các file đã sửa trong đợt này đã qua `prettier --check` riêng. |
| `pnpm typecheck`                       | PASS (exit 0)                                                                                                                                                                                             |
| `pnpm test --no-file-parallelism`      | PASS: 107 file pass, 6 skip; 1045 test pass, 6 expected fail, 72 skip (các ca CLI thật/opt-in bị skip)                                                                                                    |
| `pnpm build`                           | PASS (exit 0)                                                                                                                                                                                             |
| `pnpm audit`                           | 2 moderate (esbuild lồng trong drizzle-kit, minimatch trong eslint; cả hai dev-only), 0 high/critical                                                                                                     |
| `cargo clippy` / `cargo test --locked` | NOT_RUN trong đợt này: không sửa `src-tauri`. Lần chạy gần nhất ở `f9c233c` (xem PROGRESS). `tauri build` release biên dịch được.                                                                         |

## Acceptance gate Phase 4 (ROADMAP) — bằng chứng, chưa tick

| Tiêu chí                                                | Bằng chứng                                                                                                                    | Còn thiếu / NOT_RUN                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Không sửa đổi ngoài phạm vi được cấp trong sandbox test | Security test với agent giả xanh; probe claude thật cho thấy cổng chặn/cho đúng verdict; symlink artifact đã sửa fail-closed  | TOCTOU/hard link/mount point đã vá ở `worktree-hash.ts` (A6; mount point thật chưa có test). Hở mới tìm ra và đã vá 2026-11-10: `GitWorktrees.diff` đọc file ngoài worktree qua junction (test đỏ→xanh). Cổng chạy lại sau vá: lint, typecheck, test (1045 pass), build PASS. Cổng claude không thấy mọi lời gọi và không phải sandbox (ADR-007). Low IL: ngoại lệ Phase 4, BLOCKED (ADR-011). Cổng thật bị treo: NOT_RUN. |
| 100 workflow không mất state                            | `tests/soak/sidecar-soak.test.ts` 100 vòng với agent giả (trong bộ test xanh); CLI thật 5/5 (xem hạng mục 6)                  | 100 workflow với CLI thật: cố ý không chạy (chi phí). Chưa đo RAM theo thời gian với CLI thật.                                                                                                                                                                                                                                                                                                                             |
| Không còn lỗ hổng Critical/High chưa xử lý              | `pnpm audit` hôm nay 0 high/critical; `cargo audit` chạy lại 2026-11-10: 0 vulnerability (2 warning chấp nhận, chỉ Linux/GTK) | Chưa có đánh giá độc lập các lỗ hở TOCTOU/hard link/mount point có thuộc High hay không.                                                                                                                                                                                                                                                                                                                                   |

## Nợ và điểm cần người dùng quyết

- Đóng Phase 4 với các ngoại lệ trên, hay làm thêm (soak 100 thật, vá TOCTOU/hard link/mount point, Low IL)?
- Sidecar Node chưa được đóng gói vào installer (`sidecar_dir()` mong `sidecar/` cạnh exe, cấu hình bundle không có resources): app cài ra chưa tự chạy orchestrator. Cần cho "Fresh install" của Phase 5.
- Security CI: sửa timeout/cache cần sửa `.github/workflows/**` (file được bảo vệ, cần người dùng yêu cầu). PR #3: chưa ghép/push, chờ người dùng.
- 7C-2 (phạm vi cấp quyền thường trực): chưa lập kế hoạch để hỏi.
- A7 (spawn sớm sidecar) và A2/A4/A5/A6 của ADR-006: sau Phase 4.
- Không `git push`, không PR, không ghép vào `main` trong đợt này.
