# Kế hoạch giải quyết theo phase (soạn 2026-11-05)

File này CHỈ chứa vấn đề, các hướng giải quyết, khuyến nghị và cách kiểm chứng. Trạng thái hiện tại nằm ở `docs/HANDOFF.md`; lịch sử ở `docs/PROGRESS.md`; thứ tự phase theo ADR-005 (không đổi ở đây, đổi thứ tự là quyết định của người dùng). Thay thế các bước trong `docs/NEXT_PLAN.md`.

Quy ước mỗi vấn đề: **Hướng** (2–3 cách, kèm đánh đổi) → **Khuyến nghị** → **Người dùng quyết?** → **File chạm** → **Kiểm chứng** → **Phụ thuộc**. Chỗ nào là dependency, probe, lượt dùng CLI hay chi phí thì chỉ liệt kê lựa chọn và đánh dấu "người dùng quyết", không chọn ngầm (`CLAUDE.md`). Mọi hành vi của CLI chưa probe đều ghi "CHƯA XÁC MINH".

Kiểm chung cho mọi lane có đổi mã: `pnpm lint` (loại `.claude/**` khi có worktree lồng) `&& pnpm exec prettier --check . && pnpm typecheck && pnpm test && pnpm build`. Lane có đổi `src-tauri` thêm `cargo clippy --all-targets -- -D warnings` và `cargo test`.

## 0. Quy tắc chống xung đột (áp cho mọi lane)

| Rủi ro đã xảy ra                                                                     | Quy tắc                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/PROGRESS.md` xung đột ở hai lần ghép                                           | Phiên con KHÔNG sửa `PROGRESS.md`, `HANDOFF.md`, `TODO.md`, `ROADMAP.md`. Báo kết quả trong tin nhắn cuối (lệnh đã chạy + kết quả thật); phiên chính ghi docs sau khi ghép.                |
| CI spike đỏ vì thiếu alias trong `scripts/build-sidecar.mjs` (`2137663`)             | Bước nào thêm gói workspace mới phải thêm alias và kiểm: ẩn `dist`, chạy bundle, chạy spike (11 test). Phiên con phải chạy bước này trước khi báo xong.                                    |
| Method IPC cần sửa 4 chỗ (`contracts`, `sidecar.ts`, `lib.rs`, `preview-sidecar.ts`) | Các file này thuộc MỘT lane tại một thời điểm (lane POLICY/IPC). Lane đó chạy thêm `cargo clippy` + `cargo test`.                                                                          |
| `pnpm-lock.yaml` xung đột                                                            | Một lane được thêm dependency tại một thời điểm (lane DEPS). Mỗi dependency: license, `pnpm audit`, pin chính xác ≥ 2 tuần tuổi, ghi `docs/REFERENCES.md`. Chưa chọn phiên bản ở file này. |
| Worktree lồng trong `.claude/worktrees` làm `pnpm lint` báo lỗi giả                  | Dùng `eslint . --ignore-pattern ".claude/**"`.                                                                                                                                             |
| Phiên con dừng giữa chừng                                                            | Phiên chính kiểm lại diff và kết quả (không tin báo cáo suông) rồi mới ghép; push chỉ khi người dùng đồng ý.                                                                               |

### Lane và file sở hữu

| Lane   | Sở hữu (chỉ lane này được sửa)                                                                                                             | Ghi chú                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| POLICY | `packages/policy-engine`, `services/orchestrator/src/sidecar.ts`, `packages/contracts`, `src-tauri`, `apps/desktop/src/preview-sidecar.ts` | Cửa duy nhất cho IPC mới và Rust.                         |
| RES    | `packages/resource-monitor`; phần nối trong `sidecar-main.ts`                                                                              | Chạm `sidecar.ts` thì xếp SAU lane POLICY của cùng wave.  |
| OBS    | gói mới `packages/diagnostics` (alias + lockfile), `packages/shared-utils` (logger)                                                        | Cần quyền DEPS nếu có dependency.                         |
| UI     | `apps/desktop/src` (trừ `preview-sidecar.ts`)                                                                                              | Không thêm method IPC.                                    |
| TEST   | `tests/`, file `*.test.ts` mới                                                                                                             | Không sửa mã sản phẩm; bug tìm được báo lại cho lane chủ. |
| DEPS   | `package.json`, `pnpm-lock.yaml`                                                                                                           | Một người một lúc; cần người dùng duyệt.                  |
| DOCS   | `docs/*`                                                                                                                                   | Chỉ phiên chính.                                          |

### Thứ tự wave (song song trong wave, tuần tự giữa các wave)

| Wave | Lane chạy song song                                                                                                            | Điều kiện vào                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| W0   | Phiên chính: đọc CI `23acd7b`; xem Auto/`agy` trong app Tauri thật                                                             | Không                                            |
| W1   | POLICY (cổng kiểm trước khi chạy), OBS (log rotation + diagnostics), TEST (security test cho policy-engine, bộ khung soak)     | W0 xong                                          |
| W2   | RES (`trackedPids`, VRAM, ngưỡng), POLICY (kiểm sau khi chạy, Job Object nếu chọn hướng), UI (phê duyệt dùng đường production) | W1 đã ghép; RES sau POLICY nếu chạm `sidecar.ts` |
| W3   | POLICY (recovery 5 bước + IPC), UI (resume/retry/abandon), TEST (soak 100 workflow)                                            | W2 đã ghép                                       |
| W4   | Chờ quyết định người dùng: probe vòng quyền, 7C-2, Tailwind/Playwright, Ollama                                                 | Danh sách quyết định ở cuối file                 |
| W5+  | Phase 5, 6, 8, 9 (xem phần cuối)                                                                                               | Phase 4 + 7C-2 đóng (ADR-005)                    |

## Bước 0: việc còn mở từ `NEXT_PLAN.md`

- Đã xong: 2A policy-engine trên Windows (`327eab9`), 3 nối resource monitor (`9e460a2`), phần scheduler flaky của 4 (`34a066c`), 2B phần 1 probe quyền (`5866c85`).
- **P0-1 Đọc CI `23acd7b`** (GraphQL `statusCheckRollup`, không `gh run watch`). Chưa có kết quả; không ghi là xanh. Kiểm chứng: 5/5 job, hoặc job đỏ kèm nguyên nhân từ log. Cần người dùng quyết: không.
- **P0-2 Xem nút Auto/`agy` trong app Tauri thật.** Hướng: (a) chạy app ngầm, chỉ kiểm giao diện + lưu `localStorage` (không cần CLI); (b) thêm gửi task thật bằng `claude`/`codex` đã đăng nhập (tốn lượt dùng CLI). Khuyến nghị (a) trước. Người dùng quyết cho (b). File: không (chỉ sửa CSS nếu ô tick vỡ bố cục, thuộc lane UI). Kiểm chứng: tắt `agy` + chỉ `agy` thì báo "Không có agent phù hợp"; trạng thái nút còn sau khi khởi động lại; không vỡ ở cửa sổ hẹp.
- **P0-3 Nhánh `fix-pm-abort-flaky-7e3a1f` và `repo-current-status-acfd51`.** Người dùng quyết (ghép/bỏ).

## Phase 3 — phần còn lại

Gate: mọi adapter qua cùng contract test; thêm adapter không sửa core; hết RAM/VRAM thì degrade có kiểm soát.

- **P3-1 Adapter Ollama** (TODO: `adapter-ollama`, tool loop). Hướng: (a) viết adapter HTTP + contract test bằng máy chủ HTTP giả, không cần cài Ollama; (b) cài Ollama trên máy rồi probe thật; (c) hoãn hẳn. Khuyến nghị (a) trước, (b) khi người dùng sẵn sàng; tool loop riêng chỉ mở khi có whitelist tool và mặc định chỉ đọc, giới hạn số vòng. Người dùng quyết: (b) và việc cài/tải model. File: gói mới `packages/adapter-ollama` (+ alias `build-sidecar.mjs`, lockfile nếu có dependency). Kiểm chứng: contract test chung qua; bundle sidecar với `dist` ẩn; không sửa core. Phụ thuộc: DEPS nếu cần dependency.
- **P3-2 `trackedPids` cho resource monitor.** Vấn đề: `NodeResourceSource` trả `undefined` cho pid khác trên Windows. Hướng: (a) lấy RSS tiến trình con bằng lệnh hệ thống (`tasklist`/PowerShell `Get-Process`) với `shell:false`; (b) để process-manager báo RSS qua API riêng; (c) bỏ RSS con, chỉ dùng RAM hệ thống. Khuyến nghị (a) sau khi thử độ chính xác và chi phí, (c) là phương án lui. File: `packages/resource-monitor`, nối ở `sidecar-main.ts`. Kiểm chứng: test nguồn đo giả + một phép đo thật trên Windows ghi vào `ASSUMPTIONS.md`.
- **P3-3 VRAM.** Node không có API. Hướng: (a) đọc `nvidia-smi` nếu có; (b) PowerShell/WMI/DXGI (CHƯA XÁC MINH độ chính xác); (c) không đo, ghi giới hạn và chỉ giới hạn theo RAM. Khuyến nghị (c) cho 1.0 trừ khi Ollama thật được dùng; (a) là bổ sung có điều kiện. Người dùng quyết: có cần VRAM không (phụ thuộc P3-1b).
- **P3-4 Ngưỡng tài nguyên có cấu hình và hiển thị.** Hướng: (a) hằng số mặc định như hiện tại; (b) lưu trong bảng settings, sửa ở Settings; (c) (b) cộng chỉ báo tải trong UI. Người dùng quyết (đã nằm trong danh sách chờ). File: `contracts` + `sidecar.ts` (lane POLICY/IPC nếu thêm method), `apps/desktop`. Kiểm chứng: test nguồn đo giả cho ngưỡng đổi; UI xem trong app thật.
- **P3-5 Concurrency đọc từ settings** (nợ Phase 2, cùng quyết định P3-4). Không vượt trần `concurrency` đã đặt.
- **P3-6 Chạy `agy` thật qua adapter.** Cần lượt probe thứ 3 (người dùng cho phép). Hướng: (a) probe một task nhỏ read-only trong thư mục tạm; (b) hoãn. Ghi kết quả vào `ASSUMPTIONS.md` kèm fixture đã lọc.
- **P3-7 `PHASE3_REPORT.md`** chỉ chuyển từ bản nháp sang bản đóng khi ba gate đạt. Hiện chưa gate nào đạt.

## Phase 4 — Security & Reliability (chặn mọi thứ phía sau)

Gate: không sửa đổi ngoài phạm vi trong sandbox test; 100 workflow không mất state; không còn lỗ hổng Critical/High chưa xử lý.

### P4-1 Nối Policy Engine vào orchestrator (Bước 2B)

Vấn đề: probe 2026-11-04 cho thấy `claude -p --output-format stream-json` phát `system/permission_denied` và `permission_denials[]` SAU khi từ chối; `codex exec --json` không phát sự kiện quyền (từ chối chỉ ở stderr và văn bản mô hình). Chưa giao diện nào đã thử cho phép chèn `evaluate()` giữa "mô hình yêu cầu công cụ" và "công cụ chạy". Các hướng, độc lập nhau và có thể cộng dồn:

- **(a) Cổng kiểm TRƯỚC khi chạy ở điểm nền tảng tự kiểm soát**: gốc dự án, thư mục làm việc (cwd), argv spawn, env allowlist, đường dẫn worktree; chạy `evaluate()` fail-closed (lỗi engine = từ chối), từ chối thì không spawn. Làm được ngay bằng agent giả. Giới hạn: không thấy từng lời gọi công cụ bên trong CLI.
- **(b) Kiểm SAU khi chạy**: đọc `permission_denials[]` của claude; so diff worktree với phạm vi được cấp; thay đổi không giải thích được → `needs_reconciliation` (không tự retry). Giới hạn: phát hiện muộn, không ngăn được; codex chỉ có thể dựa vào diff.
- **(c) Cổng TRONG vòng lặp** qua `--permission-prompt-tool` của claude hoặc app-server/MCP của codex. **CHƯA XÁC MINH**: cần probe và ghi `ASSUMPTIONS.md` trước khi code. Đây là hướng duy nhất cho phê duyệt từng lệnh thật.
- **(d) Ánh xạ mức quyền sang cờ sandbox/phê duyệt của chính CLI** (`workspace-write`, chế độ quyền…). **CHƯA XÁC MINH**: cần probe riêng.

Khuyến nghị: làm (a) và (b) ngay (không cần quyết định thêm), giữ (c)/(d) ở trạng thái "chờ probe được duyệt"; không tuyên bố đã có phê duyệt từng lệnh cho tới khi (c) hoặc (d) được chứng minh. Người dùng quyết: duyệt các lượt probe (c) và (d) (tốn lượt dùng CLI, chạy trong thư mục tạm, không dùng chế độ bỏ qua quyền). File: lane POLICY (`policy-engine`, `sidecar.ts`; nếu thêm method IPC thì đủ 4 chỗ + `cargo`). Kiểm chứng: test sidecar với agent giả cho đúng allow/ask/deny; deny không spawn; lỗi engine → deny; approval được tạo qua đường production; thẻ phê duyệt hiện đủ lệnh/đường dẫn. Phụ thuộc: không cho (a)/(b); probe cho (c)/(d).

### P4-2 Canonical path trên Windows

Vấn đề: test 8.3 bị bỏ qua trên máy này nên việc sửa `realpath.native` chưa được chứng minh bằng test chạy thật. Hướng: (a) dựa vào runner CI Windows (có `RUNNER~1`), xác nhận test 8.3 chạy và qua ở đó; (b) tạo tên 8.3 bằng `fsutil` trên máy (có thể cần quyền admin, CHƯA XÁC MINH); (c) chỉ mô tả giới hạn. Khuyến nghị (a) rồi ghi kết quả CI thật; (b) chỉ khi người dùng đồng ý quyền admin. Kiểm chứng: đọc log CI Windows xác nhận test không bị bỏ qua. File: không đổi mã trừ khi test lộ lỗi (lane POLICY).

### P4-3 Env allowlist và executable allowlist theo adapter

Hướng: (a) mỗi adapter khai báo manifest (biến env, tên executable được phép) và policy-engine kiểm; (b) danh sách tập trung trong cấu hình policy; (c) chỉ kiểm khi spawn trong process-manager. Khuyến nghị (a)+(c): khai báo cạnh adapter, thực thi tại một điểm spawn duy nhất (đã `shell:false`, mảng đối số). Kiểm chứng: test env lọc (biến không khai báo không lọt), executable ngoài danh sách bị từ chối, test với agent giả. File: `process-manager`, các `adapter-*` (đụng nhiều gói nên xếp một lane POLICY).

### P4-4 Job Object / dọn process tree / giới hạn RAM

Vấn đề: Node không tạo Job Object trực tiếp. Hướng: (a) phía Rust trong Tauri đặt sidecar vào Job Object (phủ cả cây con, cần `src-tauri` + `cargo`); (b) binary phụ nhỏ bọc từng CLI con; (c) module native hoặc FFI trong Node (CHƯA XÁC MINH độ ổn định); (d) giữ cách dọn hiện có bằng kill cây tiến trình. Khuyến nghị: (a) cho giới hạn cấp sidecar, ghi rõ không phải sandbox; (b) chỉ khi cần giới hạn theo từng task. Người dùng quyết: có chấp nhận thay đổi Rust/binary phụ. Kiểm chứng: test thật trên Windows kill cây con khi sidecar chết; đo RAM; `cargo clippy`/`cargo test`. Ghi `ASSUMPTIONS.md`.

### P4-5 Spike AppContainer / Windows Sandbox

Chỉ đánh giá, không cam kết 1.0 (ADR-002). Hướng: (a) tài liệu hoá khả thi + hạn chế vào `SECURITY.md`; (b) prototype nhỏ trên máy thật. Khuyến nghị (a); (b) cần người dùng đồng ý vì đụng cấu hình hệ thống. Kiểm chứng: mục trong `SECURITY.md` ghi cả phần chưa đạt.

### P4-6 Observability và diagnostics export

Hướng: (a) gói mới `packages/diagnostics` xuất zip đã che secret; (b) mở rộng logger trong `shared-utils`; (c) cả hai, rotation/retention trong logger, export ở gói riêng. Khuyến nghị (c). Redaction hiện che theo giá trị chính xác, nên diagnostics phải chạy lại bộ che và có test: không còn secret trong DB, log, IPC, diagnostics. File: lane OBS (gói mới cần alias + lockfile). Kiểm chứng: test rò secret; rotation/retention theo thời gian giả; export mở được. Mục này đóng nợ gate Phase 7 về redaction.

### P4-7 Siết Tauri capabilities và (nếu có) WebSocket localhost

Hướng: (a) rà `src-tauri/capabilities` xoá quyền thừa, giữ `ALLOWED_METHODS`; (b) kèm thêm kiểm tra Origin + token phiên nếu có WebSocket (hiện chưa có WS thì không thêm). Khuyến nghị (a). File: `src-tauri` (lane POLICY). Kiểm chứng: `cargo test`, test `ALLOWED_METHODS`.

### P4-8 Recovery 5 bước + UI resume/retry/abandon

Hướng: (a) mở rộng reconciliation 7A (đã có) thành quy trình 5 bước; (b) engine resume sau restart cho Peer Review (nợ Phase 2); (c) tách hai việc. Khuyến nghị (c): (a) trước, (b) sau. Side effect không xác minh được → `needs_reconciliation`, không tự retry. File: `sidecar.ts`, `contracts` (IPC đủ 4 chỗ), UI. Kiểm chứng: test kill sidecar giữa workflow rồi khởi động lại; kiểm trong app thật. Phụ thuộc: P4-1 (a) đã ghép.

### P4-9 Security tests

Gồm: path escape, injection qua prompt/tên file, agent output độc hại, prompt injection từ nội dung repo. Hướng: (a) test đơn vị trên policy-engine và ngoài sidecar với agent giả; (b) thêm chạy CLI thật (tốn lượt, không đưa vào CI). Khuyến nghị (a) trong lane TEST (không sửa mã sản phẩm); (b) tuỳ người dùng. Kiểm chứng: test xanh; mỗi lỗ hổng tìm được ghi và giao lane chủ.

### P4-10 Soak test 100 workflow

Hướng: (a) agent giả, chạy 100 workflow liên tiếp trong CI, kiểm không mất state; (b) CLI thật vài chục workflow (tốn lượt, chỉ chạy tay); (c) cả hai. Khuyến nghị (a) trong CI + (b) tuỳ người dùng. Kiểm chứng: số task `completed` khớp, DB nhất quán sau mỗi vòng, không rò tiến trình/RAM. File: `tests/`. Chạy sau P4-8.

### P4-11 Rà dependency và `SECURITY.md`

`pnpm audit` + `cargo audit`, cập nhật threat model, xử lý hai cảnh báo moderate dev-only và hai cảnh báo transitive. Nợ Phase 0 (ghim Actions theo SHA, tuổi crate): Hướng (a) làm ngay trong Phase 4; (b) để Phase 6. Người dùng quyết thời điểm.

### P4-12 `PHASE4_REPORT.md` — chỉ viết khi cả ba gate đạt, kèm lệnh đã chạy và kết quả thật.

## Phase 7 — phần còn lại

Gate: E2E người dùng mới; mọi phê duyệt hiển thị đủ lệnh/đường dẫn và từ chối không treo task; không secret trong DB/log/diagnostics.

- **P7-1 7C-2 ("Luôn cho phép trong phạm vi").** Chặn bởi P4-1 và quyết định phạm vi grant (một lần / theo thư mục / theo project). Hướng: (a) chỉ cho phạm vi hẹp nhất có thể (đường dẫn con trong worktree); (b) cho phạm vi project nhưng mặc định tắt. Người dùng quyết. Kiểm chứng: grant hết hạn/thu hồi được; hiện trong nhật ký quyết định.
- **P7-2 Tailwind/shadcn (7D).** Dependency: người dùng duyệt. Hướng: (a) Tailwind + shadcn đầy đủ; (b) chỉ Tailwind, tự viết component; (c) giữ CSS hiện có với token theme sáng/tối (không thêm dependency). Quy trình adopt: license, audit, pin ≥ 2 tuần, `REFERENCES.md`. Chưa chọn phiên bản. Lane DEPS rồi UI.
- **P7-3 E2E "cài đặt → project → task thật".** Hướng: (a) Playwright trên bản preview web với stub sidecar (nhanh, không phủ Tauri thật); (b) tauri-driver/WebDriver trên app thật (CHƯA XÁC MINH trên Windows); (c) kịch bản chạy tay có chấm điểm. Playwright là dependency cần duyệt. Khuyến nghị (a) cho CI + (c) cho app thật trước khi có (b). Dùng chung cho Phase 5.
- **P7-4 Kiểm trong app thật các mục còn nợ:** preset/phím tắt, Ctrl+Enter gửi thật (cần CLI), Settings > Agents Save/Use defaults, Peer Review chạy CLI thật qua UI, danh sách radio "What happened?" xếp dọc lỏng. Lane UI; chạy ngầm, không dùng chuột/bàn phím của người dùng.
- **P7-5 Gate redaction** chỉ tick khi P4-6 xong.
- **P7-6 `PHASE7_REPORT.md`** khi cả phase đạt gate.

## Phase 5, 6, 8, 9, 10 — CHẶN bởi Phase 4 + 7C-2 (ADR-005); chỉ phác hướng

- **Phase 5 Desktop Beta.** Live Terminal cần `node-pty` (dependency, nợ spike Phase 0): hướng (a) `node-pty` trong sidecar (cần build native trên Windows, CHƯA XÁC MINH); (b) ConPTY qua Rust; (c) hoãn terminal, chỉ log tĩnh. Installer: đo kích thước, kiểm cài mới/nâng cấp/gỡ. Beta ≥ 3 dự án thật cần người dùng. Playwright dùng lại từ P7-3.
- **Phase 6 Production 1.0.** Ký mã và auto-update cần chứng chỉ/khoá của người dùng (không thể tự làm). `packages/mcp-gateway` tối thiểu kéo lên đầu bước. Ma trận tương thích CLI chạy contract test định kỳ. Ghim Actions theo SHA nếu chưa làm ở P4-11.
- **Phase 8 ACP/MCP/Skills.** Mọi quyền qua Policy Engine + Approval UI. Probe ACP với ≥ 2 agent thật (tốn lượt). Không gọi "A2A-compatible" khi chưa qua test tương thích.
- **Phase 9 Multi-agent có cấu trúc.** Cần Policy Engine để lịch chạy "không vượt policy". Ba workflow mẫu, handoff có bằng chứng, UI theo đội.
- **Phase 10 xuyên suốt.** Ngân sách hiệu năng trong CI từ Phase 5, diagnostics một nút (dùng lại P4-6), ADR Remote/WebUI.

## Danh sách quyết định của người dùng (một chỗ)

1. Duyệt probe cho P4-1 (c)/(d): `--permission-prompt-tool` của claude, app-server/MCP của codex, cờ sandbox của CLI.
2. Phạm vi grant 7C-2 (P7-1).
3. Ngưỡng tài nguyên có cấu hình/hiển thị không; concurrency đọc từ settings không (P3-4, P3-5).
4. Có cần VRAM và có cài Ollama trên máy không (P3-1b, P3-3).
5. Lượt probe `agy` thứ 3 (P3-6).
6. Duyệt dependency: Tailwind/shadcn (P7-2), Playwright (P7-3), `node-pty` (Phase 5), crate/gói cho Ollama nếu có.
7. Job Object: chấp nhận thay đổi Rust/binary phụ (P4-4); spike AppContainer có chạy thật không (P4-5).
8. Thời điểm ghim Actions theo SHA và xử lý cảnh báo audit (P4-11).
9. Chạy kiểm bằng CLI thật cho security test/soak (P4-9b, P4-10b) hay chỉ agent giả.
10. Gửi task thật khi xem Auto/`agy` (P0-2b).
11. Số phận nhánh `fix-pm-abort-flaky-7e3a1f`, `repo-current-status-acfd51`, `phase-2-kickoff-8a5732`; xoá worktree phiên con đã ghép.
12. Push mọi commit và mở PR (chưa làm gì khi chưa được yêu cầu).
