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
| Mọi adapter (Claude, Codex, Antigravity, Ollama) qua cùng contract test | **CHƯA**             | Claude, Codex, Antigravity qua `describeAdapterContract` (CLI giả). Ollama chưa có.                                                                                                                                              |
| Thêm adapter mới không sửa Orchestrator core                            | **ĐẠT, có giới hạn** | Router và `Orchestrator` nhận adapter qua registry/`extraAdapters` (test `capability-router.test.ts`). Nhưng đăng ký `agy` thật vẫn phải sửa `sidecar.ts` (hard-code theo tên), và các enum IPC/settings vẫn là `claude\|codex`. |
| Hết VRAM/RAM → degrade có kiểm soát                                     | **CHƯA**             | Resource Scheduler chưa làm.                                                                                                                                                                                                     |

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

- `adapter-ollama`, tool loop Ollama, Resource monitor + Scheduler.
- UI hiển thị capability thiếu: mới có helper `describeCapabilityGap`; phần render nằm trong `apps/desktop` (phiên khác), chưa nối. Router chưa được gọi từ `workflows.start`.
- `agy` chưa kiểm chứng: lỗi thật (chưa đăng nhập, hết hạn mức), sự kiện tool/phê duyệt, resume `--conversation`, `--sandbox`, stdin/`--input-format`, cwd, prompt nhiều dòng trên Windows với `agy` thật. Vì không phát `tool_call`, một task `agy` có side effect sẽ chỉ thành `failed`/`completed`, không thành `needs_reconciliation`.
- Settings/secrets/probe nhận biết settings cho `agy` chưa nối (IPC enum vẫn `claude|codex`; `apps/desktop` hard-code hai tên).
- Workflow đặt `permissions` (vd. Peer Review) chưa dùng được `agy`.
