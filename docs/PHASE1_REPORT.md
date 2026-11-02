# PHASE 1 REPORT

Nhánh `claude/loving-lovelace-32lh71`. Trạng thái đo: commit `818431e` (và các thay đổi tài liệu/script của Sprint E).

**Kết luận: PHASE 1 CHƯA ĐÓNG, còn hai việc.** Tiêu chí "Claude và Codex mỗi bên chạy 1 task thật" đã đạt (2026-11-02). Còn: hủy một CLI thật đang chạy tool (và Cancel trong app Tauri thật) mới đạt một phần, và CI chưa chạy cho các commit chưa push. Phần còn lại, gồm cầu nối Tauri, UI, phát hiện crash, hai adapter và baseline hiệu năng, đã làm và kiểm chứng như dưới đây.

## Acceptance gate (ROADMAP.md)

| Tiêu chí                                              | Trạng thái           | Bằng chứng / lý do                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude và Codex mỗi bên chạy được 1 task thật độc lập | **CHƯA ĐẠT**         | Codex: đạt. Một task thật chạy qua `CodexAdapter` (kết quả `completed`, có thread id) và hai lần chạy `codex exec --json` thật để lấy fixture (2026-11-02, codex-cli 0.165.0). Claude: chỉ có một lần chạy `claude -p` thật để lấy fixture (2.1.314, kết thúc với lỗi vượt ngân sách theo thiết kế của lần thử); **chưa** chạy một task qua `ClaudeAdapter`, nên `tool_use`/`tool_result`, `--resume`, prompt qua stdin và cờ cô lập vẫn chưa được kiểm chứng. Cần bạn đồng ý vì tốn usage |
| Cancel dừng cả process tree, không còn orphan         | **ĐẠT MỘT PHẦN**     | Process Manager: cancel kill-tree có test; `JobObject` Rust: đóng job giết cả con và cháu (test), sidecar tạo ở trạng thái treo → gán job → resume; kill cứng `agent-studio.exe` không để lại sidecar (đã kiểm). Cả hai adapter có test hủy bằng CLI giả. Chưa thử hủy một CLI thật đang chạy tool, và chưa bấm Cancel trong app Tauri thật (cần adapter chậm)                                                                                                                             |
| Lỗi CLI báo rõ, không crash                           | **ĐẠT, có giới hạn** | Đã có: chưa cài, shim, exit ≠ 0, timeout, spawn lỗi, version không đọc được, và lỗi thật "Not inside a trusted directory" của Codex hiển thị nguyên văn. Chưa có: "sai version" (chưa có version tối thiểu được kiểm chứng); JSON hỏng chỉ được bỏ qua âm thầm, chưa có báo lỗi                                                                                                                                                                                                            |
| Contract tests với fixture output thật của từng CLI   | **ĐẠT, có giới hạn** | Claude: help 2.1.314/2.1.316 và một luồng `stream-json` thật (chỉ có text và result lỗi). Codex 0.165.0: help, `exec --help` và hai luồng JSONL thật (text; `command_execution`). Cả hai adapter qua `describeAdapterContract`. Các dạng chưa quan sát được ghi trong `docs/ASSUMPTIONS.md`                                                                                                                                                                                                |

## Kết quả kiểm tra tự động (chạy ngày 2026-11-02, máy Windows vật lý)

| Lệnh                                                                | Kết quả                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm lint`                                                         | pass (sau khi sửa 4 lỗi `no-undef` trong `scripts/perf-baseline.mjs`)             |
| `pnpm format`                                                       | pass                                                                              |
| `pnpm typecheck`                                                    | pass                                                                              |
| `pnpm test`                                                         | 14 file, 154 test pass, 0 skip                                                    |
| `pnpm build`                                                        | pass                                                                              |
| `cargo test --locked` (src-tauri)                                   | 7 pass                                                                            |
| `cargo clippy --locked -- -D warnings`                              | sạch                                                                              |
| `pnpm tauri build --no-bundle` (release)                            | pass, `agent-studio.exe` 8,7 MiB                                                  |
| Selftest bản release, `AGENT_STUDIO_SIDECAR_DIR` trỏ `sidecar-dist` | 5/5 lần exit 0, `ok=true`, task stub `completed`; không còn sidecar sau khi thoát |
| Kill cứng app đang chạy                                             | không còn sidecar                                                                 |

**CI (GitHub Actions): chưa chạy** cho các commit hiện tại, vì 13 commit chưa được push. Kết quả CI xanh gần nhất trong tài liệu là của Phase 0 (run 6). Chưa có số CI nào cho Phase 1.

## Đã làm trong Phase 1

- Sprint A: Process Manager, Job Object (ADR-004), state machine, migration, log sink.
- Sprint B: probe Claude/Codex (fixture thật), lỗi CLI.
- Sprint C: contract suite chung; `adapter-claude` (C2), `adapter-codex` (C3), `needs_reconciliation` (C4).
- Sprint D: IPC sidecar, cầu nối Tauri (allowlist, event, hồi sinh sidecar), UI (Projects, Agents, tạo task, stream, Cancel), phục hồi task đang chạy khi khởi động; đã kiểm bằng tay trong webview thật.
- Sprint E: `scripts/perf-baseline.mjs`, `docs/PERF_BUDGET.md`, bản release và selftest, báo cáo này.

## Baseline hiệu năng (chi tiết trong `docs/PERF_BUDGET.md`)

Sidecar khởi động nguội p50 122 ms; RSS rảnh 53 MiB; stub tới message đầu p95 2,7 ms (phía sidecar, chưa qua Tauri); app release chạy selftest 741–855 ms; cây tiến trình rảnh ≈ 453 MiB (phần lớn là WebView2). Một máy, một lần chạy; ngân sách chưa được ép trong CI.

## Hạn chế và việc còn lại để đóng Phase 1

1. (Đã xong) task Claude thật qua adapter; còn nợ: tool ghi và phê duyệt, `--include-partial-messages`, hủy giữa chừng.
2. Hủy một CLI thật đang chạy tool; bấm Cancel trong app Tauri thật.
3. Push để CI chạy trên Windows/Ubuntu; ghi số run vào báo cáo này.
4. Release chỉ chạy được với `AGENT_STUDIO_SIDECAR_DIR` hoặc thư mục `sidecar` cạnh exe; chưa có đóng gói tài nguyên/installer (Phase 5). Chưa kiểm bản release trên máy thứ hai.
5. Còn nợ: `tasks.list`, hộp thoại chọn thư mục, UI phê duyệt, policy cho `projects.rootPath`, test nhánh lỗi của `JobObject::spawn`, project lạ `spike-6844` trong DB mới chưa rõ nguyên nhân.
6. Codex chưa dùng `app-server`, resume và approval; adapter không khai các khả năng đó.
