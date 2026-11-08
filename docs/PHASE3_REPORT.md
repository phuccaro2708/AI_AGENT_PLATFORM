# PHASE 3 REPORT (luồng A: Antigravity + capability router)

Nhánh: `claude/p3-agy-adapter-2c4e8f`. **Phase 3 CHƯA đóng**: mới xong luồng A (adapter `agy`, router). Ollama, Resource Scheduler và UI chưa làm.

## Đã làm

- `packages/adapter-antigravity` (`parse.ts`, `adapter.ts`, `index.ts`, CLI giả `test/fake-agy.mjs`). Chỉ dựa trên event quan sát được: `init`, `step_update` (`agent_response`), `result`.
- Thành công **chỉ khi** `status`=SUCCESS, `num_turns`>0, `response` không rỗng. Bẫy `--mode plan` (thoát 0, `response:""`, `num_turns:0`) thành `error`. Thoát 0 mà không có `result` cũng là `error`.
- Spawn bằng mảng đối số, `shell:false`; prompt là một phần tử argv sau `--print`.
- `task.permissions` được đặt thì adapter từ chối chạy (fail-closed) vì chưa có cơ chế ép quyền đã kiểm chứng.
- Đăng ký trong `SidecarService` (registry) cạnh claude/codex; `agents.scan` báo `agy` là `supported:true`; alias vitest và `scripts/build-sidecar.mjs`.
- `services/orchestrator/src/capability-router.ts`: `selectAgent` (theo capability, không theo tên), `snapshotAdapters`, `describeCapabilityGap` (nhãn tiếng Việt).

## Acceptance gate Phase 3 (ROADMAP)

| Tiêu chí                                                                | Trạng thái           | Bằng chứng                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mọi adapter (Claude, Codex, Antigravity, Ollama) qua cùng contract test | **CHƯA**             | Claude, Codex, Antigravity qua `describeAdapterContract` (CLI giả). Ollama: có (2026-11-08), qua `describeAdapterContract` với server giả.                                                                                       |
| Thêm adapter mới không sửa Orchestrator core                            | **ĐẠT, có giới hạn** | Router và `Orchestrator` nhận adapter qua registry/`extraAdapters` (test `capability-router.test.ts`). Nhưng đăng ký `agy` thật vẫn phải sửa `sidecar.ts` (hard-code theo tên), và các enum IPC/settings vẫn là `claude\|codex`. |
| Hết VRAM/RAM → degrade có kiểm soát                                     | **CHƯA**             | Đã có (RAM/CPU/VRAM cả GPU, 2026-11-08); chưa xem UI trong app thật.                                                                                                                                                             |

## Lệnh đã chạy và kết quả thật

| Lệnh                                                              | Kết quả                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec vitest run tests/contract/adapter-antigravity.test.ts` | 25 test pass                                                                                                                                                                                                             |
| `pnpm exec vitest run services/orchestrator`                      | 21 file, 162 test pass (sau khi sửa 3 chỗ test cũ khẳng định `agy` không có adapter)                                                                                                                                     |
| `pnpm lint`                                                       | không lỗi                                                                                                                                                                                                                |
| `pnpm typecheck`                                                  | không lỗi                                                                                                                                                                                                                |
| `pnpm test`                                                       | 46 file, 421 test pass ở 3 lần chạy. **Lần chạy đầu trong chuỗi lint+typecheck+test+build báo "1 error" mà tôi không đọc được chi tiết; không tái hiện ở 3 lần chạy lại.** Chưa rõ nguyên nhân, có thể là flaky/tải máy. |
| `pnpm build`                                                      | không lỗi                                                                                                                                                                                                                |
| `pnpm format` (`prettier --check .`)                              | lần đầu báo lệch định dạng ở `sidecar.ts` và `sidecar.test.ts` (CRLF do script sửa file); đã `prettier --write`, chạy lại: pass                                                                                          |

Không chạy `agy` thật; không dùng lượt probe còn lại.

## Chưa làm / nợ

- (2026-11-08: `adapter-ollama`, tool loop, VRAM, một model một lúc đã làm, xem bảng.) Còn: tool calling với model thật, `think:true`, kiểm UI Settings trong app thật.
- UI hiển thị capability thiếu: mới có helper `describeCapabilityGap`; phần render nằm trong `apps/desktop` (phiên khác), chưa nối. Router chưa được gọi từ `workflows.start`.
- `agy` chưa kiểm chứng: lỗi thật (chưa đăng nhập, hết hạn mức), sự kiện tool/phê duyệt, resume `--conversation`, `--sandbox`, stdin/`--input-format`, cwd, prompt nhiều dòng trên Windows với `agy` thật. Vì không phát `tool_call`, một task `agy` có side effect sẽ chỉ thành `failed`/`completed`, không thành `needs_reconciliation`.
- Settings/secrets/probe nhận biết settings cho `agy` chưa nối (IPC enum vẫn `claude|codex`; `apps/desktop` hard-code hai tên).
- Workflow đặt `permissions` (vd. Peer Review) chưa dùng được `agy`.

## C3: UI hiển thị capability thiếu

- Dữ liệu: dùng sẵn `agents.list` (`id`, `available`, `capabilities`) — đúng snapshot router dùng; **không thêm method IPC** (nên không đụng `lib.rs`/contracts/sidecar).
- `apps/desktop/src/capabilityGap.ts`: `gapOf`, `describeGap`, `capabilityBlocker`. Nhãn tiếng Việt sao từ `describeCapabilityGap` (desktop không import orchestrator); test so khớp từng capability để phát hiện lệch.
- Yêu cầu theo màn hình là quy ước của UI, không phải luật backend: agent đơn cần `streaming`; Peer Review cần `tool_execution` (cả hai vai chạy với `permissions`; adapter `agy` từ chối task có `permissions`).
- `AgentView`/`PeerReviewView`: nút Run bị chặn kèm lý do (vd. "agy không hỗ trợ: chạy công cụ"); Peer Review ưu tiên agent đủ capability khi chọn mặc định và gắn "(thiếu capability)" vào option.
- Đã chạy: lint, prettier --check, typecheck, test (47 file, 431 test), build — đều pass. **Chưa kiểm trong app Tauri thật** (render, bố cục câu chặn). Router vẫn chưa nối `workflows.start`.

## Cập nhật 2026-11-08: phần còn lại của Phase 3 (BẢN NHÁP, Phase 3 vẫn CHƯA đóng)

| Mục                                          | Trạng thái                                  | Bằng chứng                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 admission cho `workflows.start`/`runStub` | DONE                                        | test IPC `sidecar-admission.test.ts` (không bắt đầu khi `paused`, bắt đầu sau hồi phục)                                                                                                                               |
| P3-2 `trackedPids` Windows                   | DONE (có giới hạn)                          | `windows-process-source.test.ts` + đo thật: RSS ≤ ~3 %, CPU ±~13 %; `trackedRssBytes` chưa ảnh hưởng admission                                                                                                        |
| P3-4 ngưỡng trong Settings                   | DONE (UI chưa xem trong app thật)           | `resources.get/set`, Zod, khôi phục sau restart (test mở lại DB), thẻ Settings; clippy + cargo test sạch                                                                                                              |
| P3-5 concurrency từ Settings                 | DONE                                        | test: không vượt trần khi tải và trần cùng đổi; hạ trần không dừng task đang chạy                                                                                                                                     |
| P3-6 `agy` thật qua adapter                  | PARTIAL                                     | output, cwd, prompt nhiều dòng, lỗi (model sai, cwd sai), timeout 1 s, cancel đã kiểm; chưa kiểm: lỗi chưa đăng nhập/hết hạn mức, nội dung lỗi thật (parser bỏ), cây tiến trình con, ép quyền (KHÔNG kiểm chứng được) |
| P3-1 `adapter-ollama` (S1)                   | DONE (server giả + 1 lượt thật)             | contract test với `fake-ollama.ts`; `real-ollama.test.ts` opt-in chạy `qwen3:4b`: stream 144 đoạn, `completed`                                                                                                        |
| P3-1 tool loop (S2)                          | DONE với server giả; NOT_RUN với model thật | whitelist `list_dir`/`read_file`, confinement, giới hạn vòng (`adapter-ollama-tools.test.ts`, `tools.test.ts`); chưa có model thật gọi tool                                                                           |
| P3-1 đăng ký, không sửa core (S3)            | DONE                                        | `sidecar-ollama.test.ts`: chạy task qua lõi không đổi; `git diff 1e88cd8` trên file lõi rỗng; test cấm chữ "ollama" trong lõi                                                                                         |
| P3-3 VRAM (S4)                               | DONE (mã + test); UI NOT_RUN                | `nvidia-smi` (cả GPU, làm giảm/dừng task) và `/api/ps` (chỉ model Ollama, để xem) tách phạm vi; `vram.test.ts`, `sidecar-admission.test.ts`, `sidecar-ollama.test.ts`, `vramText.test.ts`                             |
| P3-3 một model Ollama một lúc (S5)           | DONE (server giả)                           | `model-slot.test.ts` + 4 test adapter; chưa thử hai model luân phiên trên Ollama thật                                                                                                                                 |
| S6 chạy thật, đo VRAM                        | DONE (1 model, 1 lượt)                      | `qwen3:4b`: model 3033 MiB trong VRAM, cả GPU 1468 → 4607 → 1468 MiB sau `keep_alive:0`; xem ASSUMPTIONS                                                                                                              |

Gate (chạy tuần tự trên `e78fa37`): lint, format, typecheck, test (952 pass), build đều exit 0; secret scan `findings: 0`, dòng thô còn đúng 2 phát hiện đã biết. **Cập nhật 2026-11-08:** Ollama, VRAM, một model một lúc đã có mã và test; gate đầy đủ chạy lại sau S6 ghi ở `PROGRESS.md`. Còn thiếu kiểm UI trong app thật và tool calling thật; việc tick gate và đóng Phase 3 là của người dùng, bản báo cáo này chưa được đóng.
