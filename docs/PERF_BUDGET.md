# PERF BUDGET — Agent Workspace (baseline Phase 1)

Đo ngày 2026-11-02 tại commit `818431e` (script `scripts/perf-baseline.mjs` thêm sau commit này), trên một máy duy nhất: AMD Ryzen 7 260, 15 GB RAM, Windows 11 Home, bản **release** (`tauri build --no-bundle`), Node đóng gói trong sidecar v24.18.0. Đây là **baseline một máy, một lần chạy**, chưa có phương sai giữa các lần chạy khác nhau hay giữa các máy; không dùng để so với sản phẩm khác.

## Số đo

| Chỉ số                                                   | Kết quả                                                                              | Cách đo                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Sidecar khởi động nguội → phản hồi `health` (có migrate) | p50 122 ms, min 113 ms, max 795 ms (n=10; lần đầu chậm do cache lạnh)                | `perf-baseline.mjs`, DB mới mỗi lần                                                      |
| Sidecar RSS lúc rảnh                                     | 53 MiB                                                                               | `Get-Process.WorkingSet64`, sau 1,5 s                                                    |
| Sidecar RSS sau 50 task stub                             | 63 MiB                                                                               | như trên                                                                                 |
| Độ trễ yêu cầu → `task.message` đầu tiên (StubAdapter)   | p50 1,5 ms, p95 2,7 ms (n=50)                                                        | thời gian ở phía client, qua stdio, **không** qua Tauri/webview                          |
| Độ trễ yêu cầu → `task.state` kết thúc (StubAdapter)     | p50 2,8 ms, p95 8,2 ms                                                               | như trên                                                                                 |
| Khoảng cách giữa các `task.message` liên tiếp            | p50 0,2 ms, p95 0,5 ms, max 7,6 ms (n=250)                                           | như trên                                                                                 |
| App release: khởi chạy → selftest xong → thoát           | 741 / 747 / 786 / 821 / 855 ms (n=5, exit 0, `ok=true`)                              | `Start-Process` + `WaitForExit`; bao gồm khởi tạo WebView2, sidecar, một task stub       |
| App release rảnh, cây tiến trình, working set            | ≈ 453 MiB (agent-studio 28, node 49, 6 tiến trình `msedgewebview2` ≈ 369, conhost 7) | `Get-CimInstance` theo quan hệ cha-con sau 10 s; working set tính trùng trang dùng chung |
| `agent-studio.exe` (release)                             | 8,7 MiB                                                                              |                                                                                          |
| `sidecar-dist`                                           | ≈ 91 MiB (`node.exe` 88,2 MiB, `sidecar.mjs` 1,1 MiB, SQLite 1,8 MiB)                | `scripts/build-sidecar.mjs`                                                              |

Không có tiến trình sidecar nào còn lại sau khi app thoát hoặc bị kill.

## Chưa đo (đừng suy ra từ bảng trên)

- Độ trễ end-to-end qua Tauri IPC và webview (chỉ đo phía sidecar).
- Hiệu năng với CLI thật (Claude/Codex): thời gian chờ chủ yếu do mô hình, không thuộc ngân sách của ta.
- RAM khi 2 task song song, log lớn (hàng chục nghìn message), DB lớn.
- Installer (chưa có) và kích thước cài đặt.
- Phương sai giữa các máy; máy yếu hơn (16 GB / 8 GB VRAM là cấu hình mục tiêu trong ROADMAP).

## Ngân sách đề xuất (chưa ép buộc trong CI)

Đặt rộng, để bắt hồi quy lớn mà không báo động giả; siết lại sau khi có số đo từ nhiều máy và CI (Phase 10).

| Chỉ số                                  | Ngân sách |
| --------------------------------------- | --------- |
| Sidecar khởi động nguội p50             | ≤ 500 ms  |
| Sidecar RSS rảnh                        | ≤ 100 MiB |
| Sidecar RSS sau 50 task stub            | ≤ 150 MiB |
| Stub: yêu cầu → `task.message` đầu, p95 | ≤ 50 ms   |
| App release: khởi chạy → selftest xong  | ≤ 2 s     |
| App release rảnh, cây tiến trình        | ≤ 700 MiB |
| `agent-studio.exe`                      | ≤ 15 MiB  |
| `sidecar-dist`                          | ≤ 120 MiB |

Ghi chú: phần lớn RAM và dung lượng thuộc về WebView2 và `node.exe` đóng gói; đây là chi phí của kiến trúc đã chốt (ADR-001), không phải của logic ứng dụng.

## Chạy lại

```bash
pnpm -r build && node scripts/build-sidecar.mjs
node scripts/perf-baseline.mjs --runs 10 --tasks 50
```
