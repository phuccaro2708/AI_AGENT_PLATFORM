# PHASE 1 REPORT

Nhánh `claude/loving-lovelace-32lh71`. Trạng thái đo: commit `818431e` (và các thay đổi tài liệu/script của Sprint E).

**Kết luận: PHASE 1 ĐÓNG (2026-11-02), có ba ngoại lệ ghi rõ bên dưới.** Cả bốn tiêu chí của ROADMAP đã đạt hoặc đạt có giới hạn, có bằng chứng chạy thật. Ba ngoại lệ được chuyển sang phase sau, không bị che: (1) không có kiểm tra "sai version" vì chưa có version tối thiểu được kiểm chứng (ma trận tương thích là Phase 6); (2) chưa kiểm bản release trên máy thứ hai; (3) tool ghi/phê duyệt của CLI thật chưa kiểm (Phase 2/4).

## Acceptance gate (ROADMAP.md)

| Tiêu chí                                              | Trạng thái           | Bằng chứng / lý do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude và Codex mỗi bên chạy được 1 task thật độc lập | **ĐẠT**              | Codex: một task thật qua `CodexAdapter` (`completed`, thread id), codex-cli 0.165.0. Claude 2.1.314: hai task thật qua `ClaudeAdapter` (đọc tệp bằng tool `Read`, rồi `--resume` hỏi lại); prompt qua stdin, `tool_use`/`tool_result` và `--resume` khớp parser. Phát hiện: không cô lập thì hook/plugin của người dùng chạy trong task và tốn $0,69; với `--safe-mode` tốn $0,017, nên adapter bật `--safe-mode` mặc định. Chưa thử tool ghi/phê duyệt. Chi tiết: ASSUMPTIONS.md                                                                                                   |
| Cancel dừng cả process tree, không còn orphan         | **ĐẠT**              | Có test kill-tree và `JobObject` (đóng job giết con và cháu); kill cứng `agent-studio.exe` không để lại sidecar. **Chạy thật 2026-11-02:** hủy `claude` 2.1.314 và `codex` 0.165.0 khi tool shell đang chạy `ping -n 60` — lúc hủy có 1 `ping.exe`, sau hủy còn 0, task kết thúc `cancelled` sau ≈ 1,8–2,0 s. **Trong app Tauri thật** (bản release, DB tạm, bấm nút Cancel qua WebView2): với cả Claude và Codex, `ping` biến mất, không còn `node.exe` của sidecar, task chuyển `needs_reconciliation` đúng quy tắc C4 (có `tool_call` chưa có `tool_result`, nên không tự retry) |
| Lỗi CLI báo rõ, không crash                           | **ĐẠT, có giới hạn** | Đã có: chưa cài, shim, exit ≠ 0, timeout, spawn lỗi, version không đọc được, lỗi thật "Not inside a trusted directory" của Codex hiển thị nguyên văn, và **JSON hỏng** (mới: nếu CLI kết thúc không có result, lỗi nêu số dòng không phải JSON; test cho cả hai adapter). Ngoại lệ: "sai version" — chưa có version tối thiểu được kiểm chứng, không bịa; làm cùng ma trận tương thích ở Phase 6                                                                                                                                                                                    |
| Contract tests với fixture output thật của từng CLI   | **ĐẠT, có giới hạn** | Claude: help 2.1.314/2.1.316 và một luồng `stream-json` thật (chỉ có text và result lỗi). Codex 0.165.0: help, `exec --help` và hai luồng JSONL thật (text; `command_execution`). Cả hai adapter qua `describeAdapterContract`. Các dạng chưa quan sát được ghi trong `docs/ASSUMPTIONS.md`                                                                                                                                                                                                                                                                                         |

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

**Cập nhật (cuối Phase 1):** `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm build` pass; `pnpm test` 17 file, **168 test pass** (thêm: sidecar mới khởi động không tạo project nào; JSON hỏng được báo ở Claude và Codex). Các thay đổi giao diện sau `818431e` (theme, sidebar, Settings, bố cục 3 cột, composer, thẻ lỗi) đã được chạy trong app Tauri thật ở luồng chạy task + Cancel (xem hàng Cancel); phần còn lại của giao diện (Settings, theme, Browse…) chỉ kiểm bằng trình duyệt với sidecar giả.

**CI (GitHub Actions): XANH từ run `41526633402` (commit sửa CI, 5/5 job success).** Trước đó đỏ: đã push và chạy. Run `41520802510` (`edd080e`) và `41521937556` (`0459386`) đều fail; run `41524725428` (`982232a`) chưa xong khi ghi. Các job TypeScript (ubuntu + windows) và Windows desktop spike **xanh**. Hai job fail:

1. _Tauri shell (Rust check + test, Windows)_: `cargo test --locked` — 3/7 test trong `src/sidecar.rs` fail trên runner (kể cả `a_request_times_out…` ở `assert!(!s.is_alive())`), dù 7/7 pass trên máy Legion. Chưa điều tra nguyên nhân; nghi test phụ thuộc thời gian hoặc process giả.
2. _Security_: secret scan báo 23 phát hiện, chỉ 7 được chấp nhận; toàn bộ phát hiện mới nằm ở `docs/reports/phase0-windows/spike-report.json` (Base64 High Entropy String). Chưa xác nhận bản chất dữ liệu; chưa thêm vào danh sách chấp nhận.

**Đã sửa:** job Tauri thiếu Node được ghim (thêm `actions/setup-node`) và test chờ sidecar thoát bằng polling thay vì `sleep` cố định; secret scan chấp nhận đúng dòng 28 của `spike-report.json` (task id ULID sinh tự động, đã xem). Nguyên nhân gốc của 3 test fail là suy luận (Node trên runner không phải bản ghim), được xác nhận gián tiếp vì sau sửa test pass; không tái hiện được cục bộ.

## Đã làm trong Phase 1

- Sprint A: Process Manager, Job Object (ADR-004), state machine, migration, log sink.
- Sprint B: probe Claude/Codex (fixture thật), lỗi CLI.
- Sprint C: contract suite chung; `adapter-claude` (C2), `adapter-codex` (C3), `needs_reconciliation` (C4).
- Sprint D: IPC sidecar, cầu nối Tauri (allowlist, event, hồi sinh sidecar), UI (Projects, Agents, tạo task, stream, Cancel), phục hồi task đang chạy khi khởi động; đã kiểm bằng tay trong webview thật.
- Sprint E: `scripts/perf-baseline.mjs`, `docs/PERF_BUDGET.md`, bản release và selftest, báo cáo này.

## Baseline hiệu năng (chi tiết trong `docs/PERF_BUDGET.md`)

Sidecar khởi động nguội p50 122 ms; RSS rảnh 53 MiB; stub tới message đầu p95 2,7 ms (phía sidecar, chưa qua Tauri); app release chạy selftest 741–855 ms; cây tiến trình rảnh ≈ 453 MiB (phần lớn là WebView2). Một máy, một lần chạy; ngân sách chưa được ép trong CI.

## Hạn chế chuyển sang phase sau

1. Tool ghi/phê duyệt, `--include-partial-messages` với Claude thật; Codex `turn.failed`, resume, `app-server`, ép read-only (xem ASSUMPTIONS). → Phase 2/4.
2. "Sai version": cần ma trận tương thích. → Phase 6.
3. Release chỉ chạy được với `AGENT_STUDIO_SIDECAR_DIR` hoặc thư mục `sidecar` cạnh exe; chưa có installer; chưa kiểm trên máy thứ hai. → Phase 5.
4. Nợ đã ghi, không chặn Phase 1: `tasks.list` (session mất khi mở lại app), hộp thoại Browse… chưa kiểm trong app thật, UI phê duyệt, policy cho `projects.rootPath`, test nhánh lỗi của `JobObject::spawn`, `cargo audit` cho plugin dialog, ẩn adapter `stub` ngoài chế độ dev. → Phase 2/7/4.
5. Đã giải quyết: project lạ `spike-NNNN` — do constructor `SidecarService` tạo mỗi lần sidecar khởi động (di sản Phase 0 cho `runStub`); nay chỉ tạo khi gọi `runStub`, có test.
6. Codex chưa dùng `app-server`, resume và approval; adapter không khai các khả năng đó.
