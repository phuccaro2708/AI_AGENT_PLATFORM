# Bàn giao tiến độ

Cập nhật: 2026-11-05 (nhánh chính `claude/loving-lovelace-32lh71` ở `c0928af`, đã push, khớp origin; CI `191e7b9` 5/5 xanh, CI `c0928af` mới đọc 2/5 job xanh, 3 job còn đang chạy). Nhật ký chi tiết theo thời gian nằm ở `docs/PROGRESS.md`; file này chỉ nêu trạng thái hiện tại để người tiếp quản đọc nhanh.

## Vị trí

- Nhánh chính `claude/loving-lovelace-32lh71` ở `7e58f89`, ĐÃ push (origin khớp). Đã chứa Phase 4 mã thuần (merge `98539d3`), bốn nhánh phiên con cũ và bản sửa alias `2137663`. Nhánh phiên con còn trong git: `claude/p4-policy-f38236`, `claude/p4-obs-7f0c36`, `claude/p4-tests-c781ca` (đã ghép; `86ee0e9` KHÔNG ghép). PR #2 đã MERGED.
- Bốn nhánh phiên con đã ghép vào nhánh chính (2026-11-05, `f11a353`): `policy-win-hardening` (policy-engine trên Windows: `realpath.native`, UNC/ADS), `wire-resource-monitor` (monitor nối vào `SidecarService`), `flaky-root-cause` (scheduler flaky là lỗi test, đã sửa test), `probe-permissions` (probe quyền thật của `claude`/`codex`, fixture + ASSUMPTIONS). Kiểm đầy đủ trên Windows sau ghép: lint (loại `.claude/**`), prettier, typecheck, build thoát 0; `pnpm test` 55 file, 531 qua, 3 bỏ qua. `cargo` chưa chạy lại (`src-tauri` không đổi).
- Nhánh CHƯA ghép: `claude/fix-pm-abort-flaky-7e3a1f` (`cf97850`, chỉ ghi chú PROGRESS, chưa push). Router có thể chọn `agy` (adapter chỉ qua CLI giả): người dùng đã quyết KHÔNG loại mà thêm nút bật/tắt (`91317e4`, mặc định bật).
- Thứ tự phase đã chốt lại 2026-11-04 (ADR-005, ROADMAP mục "Thứ tự thực hiện"): Phase 7 (phần không cần policy) song song Phase 3 → Phase 4 (+ 7C-2, đóng Phase 7) → Phase 5 → Phase 6 (`mcp-gateway` đầu) → Phase 8 → Phase 9; Phase 10 xuyên suốt.
- Ứng dụng: **Agent Workspace** (Tauri 2 + React/Vite, sidecar Node orchestrator, SQLite/Drizzle, pnpm monorepo).
- Giữ nguyên `identifier` `dev.agentstudio.desktop`, gói `@agent-studio/*`, service Credential Manager `agent-studio` (đổi sẽ mất dữ liệu và secret đã lưu).

## Trạng thái các phase

| Phase                                              | Trạng thái                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0, 1                                               | Đóng (`PHASE0_REPORT.md`, `PHASE1_REPORT.md`)                                                                                                                                                                                                                                                                                                                                           |
| 2 Peer Review MVP                                  | Đóng 2026-11-03, có ngoại lệ, tag `mvp-phase2`                                                                                                                                                                                                                                                                                                                                          |
| 7A (lịch sử task, reconciliation)                  | Xong, kiểm trong app Tauri thật                                                                                                                                                                                                                                                                                                                                                         |
| 7B (project policy, cấu hình agent, secrets)       | Xong, kiểm trong app Tauri thật                                                                                                                                                                                                                                                                                                                                                         |
| Quét CLI (`agents.scan`)                           | Đã gộp (`2380045`); chỉ phát hiện, chưa chạy task                                                                                                                                                                                                                                                                                                                                       |
| Redaction secret                                   | Xong (`3a9a85b`), chỉ che theo giá trị chính xác                                                                                                                                                                                                                                                                                                                                        |
| 7C-1 (thẻ phê duyệt, nhật ký, timer, phạm vi khoá) | Xong 2026-11-04, kiểm trong app Tauri thật; chưa có đường production tạo approval (Phase 4)                                                                                                                                                                                                                                                                                             |
| Preset, phím tắt cơ bản, radio thẻ ngang           | Xong 2026-11-04, đã kiểm trong app Tauri thật (trừ Ctrl+Enter gửi thật cần CLI)                                                                                                                                                                                                                                                                                                         |
| 3 (quét CLI, `agy`, router)                        | Đang làm: adapter `agy` (CLI giả), router, UI capability thiếu (Peer Review kiểm app thật; nhánh AgentView chỉ có unit test) xong; router đã nối vào `workflows.start` (kèm "Auto" + bật/tắt `agy` trong UI); resource monitor đã nối vào sidecar (chưa VRAM, `trackedPids`, UI, cấu hình); còn Ollama (hoãn), chạy `agy` thật                                                          |
| 4 Policy Engine (mã thuần)                         | ĐÃ ghép vào nhánh chính (`98539d3`): P4-1 a+b (cổng kiểm trước/sau khi chạy), P4-3, P4-6 (gói `diagnostics` + logger xoay vòng, chưa nối IPC), P4-9, P4-10 với agent giả; 5 gate thoát 0 trên nhánh chính (67 file, 662 qua, 6 expected fail, 3 bỏ qua). Còn: P4-1 (c)/(d) chờ probe, P4-2 (đọc CI Windows), P4-4, P4-5, P4-6 nối IPC + nút Settings, P4-7, P4-8, P4-11                 |
| 4 phần còn lại (2026-11-05)                        | Đã ghép `f829e9d`..`b370082`: Job Object sidecar + `agent-job-wrap` (chưa nối orchestrator), capabilities siết, `diagnostics.export` IPC + nút, recovery 5 bước + UI, audit + ghim Actions, `docs/SECURITY.md`; P4-1 c/d chỉ probe. Phase 4 CHƯA đóng, không có `PHASE4_REPORT.md` Đã kiểm trong app Tauri thật (debug build `191e7b9`): ACL, recovery, kill đột ngột, diagnostics, UI. |
| 7C-2, 7D Tailwind/shadcn, E2E người dùng mới       | Chưa bắt đầu (7C-2 chờ Phase 4; Tailwind/shadcn chờ duyệt dependency)                                                                                                                                                                                                                                                                                                                   |
| `PHASE7_REPORT.md`                                 | Chỉ viết khi cả Phase 7 đạt tiêu chí đóng                                                                                                                                                                                                                                                                                                                                               |

`claude`, `codex` chạy được task thật; `agy` (Antigravity 1.4.8) đã có adapter (thành công chỉ khi `num_turns` > 0 và `response` không rỗng) nhưng mới qua contract test với CLI giả, chưa chạy `agy` thật (còn 1 lượt probe cần người dùng cho phép). Gemini đã bỏ khỏi roadmap và khỏi README/CLAUDE.md.

## CI

- Commit `1009755`: đủ 5 job xanh (Security chạy khoảng 41 phút với bản quét cũ; bản quét mới chưa có số đo trên CI).
- `babca05` đỏ do Prettier lệch ở `docs/HANDOFF.md`; `868daef` (đã format lại) xanh đủ 5/5 job (2026-11-04). PR #1 đã merged nên không còn PR nào được ứng dụng theo dõi.
- `3d5925f`: TypeScript (ubuntu, windows), Tauri và một lượt Security (bản quét mới, lần đầu trên Linux) xanh; chưa đọc đủ kết luận các lượt còn lại.
- `1540a4f`: xanh cả 10 check run (2026-11-04). Security chạy 7,1 phút (push) và 5,9 phút (pull_request) với bản quét mới, so với khoảng 41 phút trước đó.
- `f75a72b`: chưa có kết luận (lần đọc gần nhất: TypeScript ubuntu xanh, các job khác còn chạy/xếp hàng).
- `7275822`: xanh đủ 5/5 job (TypeScript ubuntu 1 phút 26 giây, windows 2 phút 25 giây, Tauri 5 phút 13 giây, Security 9 phút 20 giây, spike 5 phút 27 giây; phiên con `ci-read-48ff83e` đọc bằng GraphQL, tôi chưa tự đọc lại). `48ff83e` có TypeScript ubuntu đỏ ở `pnpm test`: `services/orchestrator/src/scheduler.test.ts` "never runs more than `concurrency` tasks at once" hết 5000ms (phiên con `ci-log-48ff83e` đọc log); không có thay đổi nào ở scheduler giữa `48ff83e` và `7275822`. Chạy cục bộ 40 lần song song (8 luồng × 5) đều qua, chưa tái hiện; nghi ngờ phụ thuộc thời điểm (`setImmediate` rồi `tick`), chưa chứng minh. PR #2: chưa đọc kết quả CI của `cdd2c06`/`a3f9d20`.
- Đọc 2026-11-05 (GraphQL): `603d6fb` xanh đủ 5/5 job (kể cả Security). `341190d`: TypeScript ubuntu/windows, Tauri shell, spike xanh, Security còn chạy. `91317e4`: TypeScript ubuntu/windows xanh, ba job còn lại còn chạy. `0183a85`: TypeScript ubuntu xanh, còn lại còn chạy (commit chỉ đổi docs).
- `3db3aa9` và `2826397` (cũ): TypeScript ubuntu xanh, TypeScript windows ĐỎ do 8 test `policy-engine` so tên 8.3 `RUNNER~1` với tên dài (test helper `makeTree` dùng `fs.realpathSync`). `603d6fb` (`realpathSync.native`): TypeScript ubuntu, TypeScript windows, Tauri shell, spike ADR-001 xanh; Security còn IN_PROGRESS lúc đọc (GraphQL, 2026-11-05). Chưa có kết luận Security.
- `91317e4`, `4ade477`: xanh đủ 5/5 job (đọc GraphQL 2026-11-05). `f11a353`: spike ADR-001 ĐỎ ở bước "Build self-contained sidecar bundle": esbuild không phân giải `@agent-studio/resource-monitor` vì `scripts/build-sidecar.mjs` dùng bảng alias gõ tay và thiếu gói mới (sót khi ghép; phiên con không chạy bước bundle). Sửa ở `2137663` (thêm alias), kiểm cục bộ với `dist` ẩn: bundle OK, spike 11/11 qua. `2137663` CHƯA push nên CI vẫn đỏ ở job spike; bốn job còn lại của `f11a353` còn chạy lúc đọc, chưa có kết luận.
- `b370082` (2026-11-05, GraphQL): xanh đủ 5/5 job. Đường đi: `ee6ed72` Security đỏ (secret scan) → `d37f38a` thêm pragma + 88 tuple lịch sử, Security xanh nhưng Windows TS đỏ (test 8.3 quá 5 giây) → `b370082` timeout 60 giây. Test 8.3 chạy và qua trên runner Windows (P4-2 đạt).
- Đọc CI bằng GraphQL (`checkSuites`/`checkRuns`), không dùng `gh run view`/`gh run watch` (REST từng chạm trần 5000/giờ, trả 403).
- `3a9a85b` có chuỗi secret giả trong test. Nếu bộ quét báo, chỉ thêm đúng tuple đã rà soát vào danh sách chấp nhận của `scripts/secret-scan.py`, không nới lỏng bộ quét.

## Việc tiếp theo (theo thứ tự)

0. Phase 4: duyệt hướng P4-1 c/d (xem `docs/ASSUMPTIONS.md`, mục probe 2026-11-05) rồi nối cổng quyền vào orchestrator; nối `agent-job-wrap` vào process-manager + gói cài đặt; engine resume Peer Review (P4-8 b); (recovery, diagnostics, kill đột ngột/Job Object, capabilities đã kiểm trong app Tauri thật 2026-11-05, xem PROGRESS); duyệt 5 bước recovery. Sau đó mới xét `PHASE4_REPORT.md`.
1. Mọi gói workspace mới phải được thêm vào alias của `scripts/build-sidecar.mjs`. CI `191e7b9` đã xanh 5/5 (đọc bằng GraphQL 2026-11-05).
2. Xem nút "Auto" + bật/tắt `agy` trong app Tauri thật (NEXT_PLAN Bước 1; mới có unit/sidecar test).
3. Bước 2B (nối `evaluate()` vào orchestrator): probe `--permission-prompt-tool` (claude) và `app-server` (codex) đã xong (xem ASSUMPTIONS, mục probe 2026-11-05) nhưng cổng của claude không thấy mọi lời gọi; chưa nối mã, chờ người dùng duyệt hướng.
4. Phase 3 còn lại: `trackedPids`/VRAM/UI/ngưỡng cho resource monitor; chạy `agy` thật (xin phép lượt probe); Ollama hoãn.
5. Phase 7 còn lại: Tailwind/shadcn (cần duyệt dependency: pin ≥ 2 tuần, audit, license, `docs/REFERENCES.md`), kiểm preset/phím tắt trong app thật, E2E người dùng mới. (`CLAUDE.md` đã sửa trong `c85d130`.) 7C-2 và đóng Phase 7 chờ Phase 4.

## Chờ người dùng quyết

- Duyệt hướng P4-1 c/d (claude `--permission-prompt-tool` nhưng cổng không thấy mọi lời gọi; codex `app-server` có approval có cấu trúc, `exec --json` không có) và định nghĩa 5 bước recovery.
- Duyệt dependency Tailwind/shadcn và Playwright; cho phép lượt probe `agy` thứ 3; duyệt phạm vi grant 7C-2; xác nhận có bỏ `claude/phase-2-kickoff-8a5732` không.
- Xoá worktree phiên con đã ghép (policy-win-hardening-057ef1, wire-resource-monitor-df9e6e, flaky-root-cause-361311, probe-permissions-ed36ea; thêm fix-pm-abort-flaky-7e3a1f, repo-current-status-acfd51 nếu bỏ nhánh): chưa xoá cái nào. Duyệt probe tiếp cho Bước 2B; ngưỡng tài nguyên và có hiện trong UI không.
- Dọn A5 không làm mất dữ liệu người dùng: mục `index/claude.agent-studio` đã xoá là danh sách TÊN secret của provider claude do chính app tạo (`secrets.rs`), nhiều khả năng là tàn dư kiểm 7B; người dùng xác nhận chưa từng nhập secret nào. Không có mục thì Settings hiện danh sách rỗng (NoEntry → rỗng), không lỗi.
- Nhánh `claude/phase-2-kickoff-8a5732` là bản Phase 2 cũ, xung đột add/add; khuyến nghị không gộp.

## Chưa xác minh / nợ nhỏ

- Test 8.3 đã chạy và qua trên CI Windows (2026-11-05); trên máy này vẫn có thể bị bỏ qua nếu volume tắt tên 8.3. Ghi chú cũ: `canonicalize` đã dùng `realpath.native` trên Windows (ghép từ `policy-win-hardening`), nhưng test 8.3 bị bỏ qua trên máy này nên việc sửa 8.3 chưa được chứng minh bằng test chạy thật. Commit `wire-resource-monitor` có bước rà soát bảo mật tự động không hoàn tất (không đọc được phản hồi mô hình): chưa có kết luận bảo mật.
- `cargo clippy --all-targets -D warnings` qua và `cargo test` 12 qua, 0 lỗi, 1 ignored (2026-11-05, Windows, `--locked`; phiên con đọc, `src-tauri` không đổi).
- 2026-11-05 trên Windows (sau sửa `..` theo Win32): lint, prettier, typecheck, build qua; `pnpm test` 485 qua, 2 bỏ qua (test POSIX), 0 đỏ (số liệu của thời điểm đó). `process-manager` "cancels via AbortSignal" hết 30 giây 1 lần ở lần chạy trước (qua 2/2 khi chạy riêng và qua ở lần chạy sau): nghi flaky, chưa điều tra. `cargo clippy`/`cargo test` chưa chạy lại. Sau đó đã ghép hai nhánh cloud và thêm nút `agy`: `pnpm test` 54 file, 520 qua, 2 bỏ qua (xem PROGRESS).

- 2026-11-04 (sau 7C-1): `pnpm lint`, `typecheck`, `test` (44 file, 389 test), `build` qua. Rust không đổi nên `cargo clippy`/`cargo test` chưa chạy lại (lần trước: clippy sạch, 12 test qua, 1 bỏ qua). `cargo audit` 0.22.2: không lỗ hổng; hai cảnh báo transitive (`proc-macro-error` không bảo trì, `glib 0.18.5` unsound).
- Đã kiểm trong app thật (2026-11-04): thẻ phê duyệt, Decision log, History (Older, giờ), sidebar hẹp, theme tối. B1 (resume Peer Review với CLI thật) đạt cả hai chiều claude↔codex.
- Timer hết hạn 5 giây chỉ được chứng minh bằng test đơn vị; trong app thật UI poll `approvals.list` (cũng gọi `expireDue`) nên chưa tách riêng được.
- Chưa kiểm trong app thật: Settings > Agents Save/Use defaults, Peer Review chạy CLI thật qua UI. Danh sách radio "What happened?" trong thẻ reconciliation xếp dọc, trông lỏng (chưa sửa).
- Secret có thể lọt vào log nếu CLI tự in môi trường của nó (redaction không bao phủ giá trị bị biến đổi).
- Test flaky đã biết: `scheduler.test.ts` (timeout 5 giây trên CI ubuntu, 1 lần ở `48ff83e`), `sidecar-resume.test.ts` (1 lần cục bộ khi máy tải), `git-worktrees` (1 lần). Chưa nới timeout; hướng sửa đề xuất: chờ điều kiện rõ ràng thay vì `setImmediate`.
- Test `git-worktrees` từng flaky một lần; `logs.search` (LIKE) chưa benchmark.

## Quy ước làm việc

- Trả lời tiếng Việt có dấu. Kiểm thử app chạy ngầm, không dùng chuột/bàn phím của người dùng.
- Spawn process bằng mảng đối số, `shell: false`. Worktree không phải sandbox. Task có side effect không xác minh được → `needs_reconciliation`, không tự retry.
- Method IPC mới cần sửa 4 chỗ: Zod variant (`contracts`), `case` trong `sidecar.ts`, `ALLOWED_METHODS` + test trong `src-tauri/src/lib.rs`, stub trong `apps/desktop/src/preview-sidecar.ts`.
- Push gộp theo lô vì Security chậm; chỉ push khi người dùng đồng ý.

## Chuyển sang Claude Cloud

Xem `docs/CLOUD_HANDOFF.md`: việc nào chạy được trên cloud, việc nào phải chờ máy Windows của người dùng.
