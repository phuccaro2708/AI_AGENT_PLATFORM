# LOOP_CRITERIA — tiêu chí nghiệm thu gắn với lệnh trong `loop.config.json`

Cập nhật: 2026-11-10. Loop Runner chạy một tiêu chí có `command`/`args` trong cwd của phase (giới hạn cứng 10 phút; schema tiêu chí không có `timeoutMs`): exit 0 là PASS, mọi trường hợp khác là FAIL; tiêu chí không có lệnh là NOT_RUN, không bao giờ PASS. Tài liệu này **không** đóng hay đổi trạng thái phase nào; trạng thái phase vẫn theo `docs/ROADMAP.md`.

Nguyên tắc gắn lệnh: chỉ gắn khi một lệnh có sẵn kiểm chứng ĐÚNG tiêu chí chỉ bằng exit code. Test liên quan lỏng lẻo, test chỉ chạy với agent/CLI giả mà tiêu chí đòi bản thật, hoặc tiêu chí thủ công/E2E/CI thì để trống. Không viết test mới, không nới test.

## Đã gắn lệnh (2 trên 19)

**Phase 3 — Mọi adapter trong gate (Claude, Codex, Ollama) qua cùng bộ contract test**

- Lệnh: `pnpm exec vitest run --no-file-parallelism tests/contract/adapter-claude.test.ts tests/contract/adapter-codex.test.ts tests/contract/adapter-ollama.test.ts`
- Chứng minh: cả ba adapter gọi `describeAdapterContract` (cùng bộ contract) và qua; kèm parse fixture thật của Claude/Codex.
- KHÔNG chứng minh: chỉ CLI/server giả; Ollama thật mới 1 model, 1 lượt (`real-ollama.test.ts` opt-in, không nằm trong lệnh). `agy` ngoài gate (ADR-009). Không phát hiện nếu ai xoá lời gọi contract khỏi một file.
- Bằng chứng chạy 2026-11-10 (serial): 3 lần exit 0, 18-21 s, 3 file, 74 test pass.

**Phase 7 — Không có mật khẩu/token trong DB, log hoặc diagnostics (test redaction)**

- Lệnh: `pnpm exec vitest run --no-file-parallelism services/orchestrator/src/sidecar-redaction.test.ts services/orchestrator/src/sidecar-secret-leak.test.ts services/orchestrator/src/sidecar-diagnostics.test.ts packages/diagnostics/src/diagnostics.test.ts`
- Chứng minh: secret đã đăng ký bị che trong DB, log, phản hồi IPC, sự kiện đẩy ra, `artifacts.diff` và gói diagnostics; gói mở được và khớp manifest.
- KHÔNG chứng minh: che theo giá trị chính xác (không bắt secret chưa đăng ký, giá trị dưới 6 ký tự; xem `docs/SECURITY.md`); chưa kiểm secret thật trong bundle thật. ROADMAP vẫn chưa tick mục này.
- Bằng chứng chạy 2026-11-10 (serial): 3 lần exit 0, 36-39 s, 4 file, 19 test pass.

Phase 7 không thể đóng chỉ nhờ lệnh này: hai tiêu chí còn lại không có lệnh.

## Để trống (17) và lý do

| Phase | Tiêu chí                                                 | Lý do không gắn                                                                                                                                           | Việc còn thiếu                                             |
| ----- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 3     | Thêm adapter mới không sửa Orchestrator core             | "Không sửa core" là tính chất của diff, không phải hành vi chạy. `sidecar-ollama.test.ts` chỉ chạy task qua lõi; đăng ký `agy` thật vẫn sửa `sidecar.ts`. | Test cấu trúc (thiếu test).                                |
| 3     | Hết VRAM/RAM thì degrade có kiểm soát, không treo máy    | `sidecar-admission.test.ts` dùng số đo giả, không chứng minh trên máy thật; PHASE3_REPORT: app thật NOT_RUN.                                              | Thử ngưỡng với task chạy thật trong app Tauri (thủ công).  |
| 4     | Không sửa đổi ngoài phạm vi trong sandbox tests          | Test policy-engine/process-manager chứng minh quyết định policy và argv, không chứng minh agent thật không ghi ngoài phạm vi; Low IL PARTIAL (ROADMAP).   | Test sandbox ghi thật với CLI thật.                        |
| 4     | 100 workflow không mất state                             | `tests/soak/sidecar-soak.test.ts` dùng agent giả; ROADMAP ghi 100 workflow thật chưa chạy (mới 5).                                                        | Soak CLI thật (thủ công).                                  |
| 4     | Không còn lỗ hổng Critical/High chưa xử lý               | Không có lệnh offline quyết định được; `pnpm audit` cần mạng và không phủ hết.                                                                            | Review bảo mật độc lập + audit CI.                         |
| 7     | Người dùng mới từ cài đặt đến chạy task thật             | Kịch bản E2E chưa có (Playwright chưa có, installer BLOCKED).                                                                                             | Kịch bản E2E (thiếu test).                                 |
| 7     | Phê duyệt hiển thị đủ lệnh/đường dẫn; từ chối không treo | `approvals.test.ts` chỉ kiểm nửa "từ chối" ở tầng dịch vụ; phần "hiển thị" nằm trong UI Tauri, chưa có test.                                              | Test UI (thiếu test).                                      |
| 5     | Approval, cancel, retry, diff, logs nhất quán            | Tiêu chí UI xuyên suốt, không test nào bao phủ.                                                                                                           | E2E UI (thiếu test).                                       |
| 5     | Fresh install / upgrade / uninstall smoke test           | Cần installer thật; máy không có NSIS/WiX (BLOCKED).                                                                                                      | Smoke test trên máy sạch.                                  |
| 6     | Toàn bộ bảng Production acceptance                       | Bảng nhiều nhóm gồm packaging, UI; cần chứng cứ thủ công/CI.                                                                                              | Chạy bảng nghiệm thu.                                      |
| 8     | Thêm agent ACP thứ hai không sửa core                    | Chưa có mã ACP/MCP/Skills trong repo.                                                                                                                     | Cần mã và test.                                            |
| 8     | Permission từ ACP bị chặn theo policy                    | Như trên; test policy-engine chỉ chứng minh engine, không phải đường ACP.                                                                                 | Test ACP + policy (thiếu test).                            |
| 8     | Skill/MCP không rõ nguồn không kích hoạt âm thầm         | Như trên.                                                                                                                                                 | Cần mã và test.                                            |
| 9     | 3 workflow mẫu chạy thật, tái lập được                   | Cần CLI thật và dự án mẫu; thủ công.                                                                                                                      | Chạy thật.                                                 |
| 9     | Kill app giữa workflow, mở lại: trạng thái đúng          | `sidecar-resume.test.ts` mô phỏng khởi động lại trong tiến trình cho Peer Review, không phải kill app trên workflow mẫu Phase 9.                          | Test kill app thật.                                        |
| 9     | Lịch chạy không vượt policy kể cả khi vắng mặt           | Chưa có lịch chạy theo thời gian (`scheduler.test.ts` là hàng đợi nội bộ).                                                                                | Cần mã và test.                                            |
| 10    | Vượt ngân sách hiệu năng thì CI đỏ                       | Là hành vi của CI (`docs/PERF_BUDGET.md`), không kiểm bằng lệnh cục bộ.                                                                                   | Kiểm trên CI.                                              |
| 10    | Diagnostics không chứa secret hoặc đường dẫn cá nhân     | Test hiện có chỉ phủ secret, không kiểm đường dẫn cá nhân; gắn lệnh sẽ khẳng định nửa vời.                                                                | Test đường dẫn cá nhân trong gói diagnostics (thiếu test). |

## Tổng theo phase

| Phase | Tổng | Có lệnh | Thủ công |
| ----- | ---- | ------- | -------- |
| 3     | 3    | 1       | 2        |
| 4     | 3    | 0       | 3        |
| 7     | 3    | 1       | 2        |
| 5     | 2    | 0       | 2        |
| 6     | 1    | 0       | 1        |
| 8     | 3    | 0       | 3        |
| 9     | 3    | 0       | 3        |
| 10    | 2    | 0       | 2        |

Kiểm: `node D:\Program\loop-runner\dist\cli.js check --project .` liệt kê tiêu chí có lệnh và NOT_RUN (`check` không chạy lệnh).
