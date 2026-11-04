# Nhật ký tiến trình

Ghi theo thứ tự thời gian; số liệu lấy từ lịch sử git và các báo cáo phase. Đây là nhật ký, không thay `PHASEn_REPORT.md` (báo cáo đóng phase). Cập nhật lần cuối: 2026-11-04.

## Tổng quan

| Phase             | Trạng thái                                                                               | Bằng chứng                            |
| ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| 0                 | Đóng                                                                                     | `docs/PHASE0_REPORT.md`               |
| 1                 | Đóng 2026-11-02 (CI xanh run 41551598060)                                                | `docs/PHASE1_REPORT.md`               |
| 2 Peer Review MVP | Đóng 2026-11-03, có ngoại lệ, tag `mvp-phase2`                                           | `docs/PHASE2_REPORT.md`               |
| 7A                | Code và test xong, đã push; kiểm trong app Tauri thật đạt cả 4 mục (2026-11-04), CI xanh | commit `428b422`…`eb80d83`, `593e153` |
| 7B                | Xong; CI của `52660f3` xanh đủ 5 job (Security 41 phút); kiểm app Tauri thật đạt         | commit `ea4c183`…`52660f3`            |
| 7C, 7D            | Chưa bắt đầu (7C cần nguồn approval từ Phase 4)                                          | `docs/TODO.md`                        |

## 2026-11-02 — Phase 0–1

- Phase 0 và Phase 1 đóng; CI đủ 5 job xanh (`63d7ef5`, `b8a102c`).

## 2026-11-03 — Phase 2 (9 bước)

Router bền vững, DAG + scheduler với lease, `git-worktrees`, workflow engine Peer Review với vai và bảng ngữ cảnh, approval và artifact, IPC, UI Peer Review, e2e với Claude/Codex thật, `PHASE2_REPORT.md`. Quy tắc giữ nguyên: task đang chạy mà lease hết hạn hoặc crash → `needs_reconciliation`, không tự retry.

## 2026-11-03 — 7A (nợ Phase 2, lịch sử task)

- `tasks.history`, `logs.search`, `tasks.resolveReconciliation`, engine resume sau restart, tab History, thẻ "Needs your decision".
- e2e resume với claude → codex đã chạy thật.

## 2026-11-03 — 7B (6 bước)

1. `ea4c183` policy cho `projects.rootPath` (tồn tại, canonical, không quá rộng, không trùng).
2. `a104af8` chọn thư mục là lệnh native; webview mất quyền dialog.
3. `998ba7f`, `fce54cb` cấu hình agent theo provider (command/args/env), chỉ lưu sau probe có capability thật; args denylist, env allowlist; migration `0005`.
4. `63d07e7` secrets trong Windows Credential Manager, webview chỉ ghi/xóa/liệt kê tên, tiêm vào sidecar khi spawn theo provider, đổi secret thì restart sidecar (từ chối khi còn task).
5. `6461cf2` UI Settings → Agents (Check/Save/Use defaults, mục Secrets).
6. `7b8cb23` cập nhật ASSUMPTIONS, ROADMAP, TODO. Đã push.

Kiểm (lúc xong 7B; hiện là 358 test): lint, typecheck, 357 test, build, prettier; `cargo test` 12 qua + 1 bỏ qua (Credential Manager thật, chạy tay với `--ignored` đã qua), clippy sạch.

## Việc mở

- Kiểm 7A trong app Tauri thật (7B đã kiểm, xem TODO.md).
- CI của `52660f3` (run `41736953160`): bốn job xanh, job Security chưa đọc được kết quả vì GitHub API trả 403; chưa push `da9614c`, `803ccac`, `bf25c42`.
- `cargo audit` chưa cài; `keyring-core` 1.0.1 mới 21 ngày tuổi.
- Secret có thể lọt vào log task nếu CLI tự in môi trường của nó.
- Test `git-worktrees` từng flaky một lần; `logs.search` (LIKE) chưa benchmark.
- 7C Approval UI, 7D Tailwind/shadcn + phím tắt, rồi `PHASE7_REPORT.md`.

## 2026-11-03 (tối) — Đối chiếu roadmap, CLI mà app quét

- Kiểm: lint, typecheck, 358 test qua. CI của `52660f3` (run `41736953160`): 4 job xanh; job Security (bước secret scan, bắt đầu 23:10:16Z) chạy hơn 45 phút, chưa đọc được kết quả vì GitHub API trả 403 (nhiều bộ theo dõi dùng chung hạn mức). `da9614c` và `803ccac` chưa push.
- App không quét "model" LLM. Nó chỉ dò **CLI agent** có thật trên máy qua `agents.detect`/`agents.probe`: `claude` và `codex` (Gemini CLI và Ollama thuộc Phase 3, chưa có code). Mỗi CLI được ghi: đường dẫn, version, bảng capability suy từ `--help` (kể cả cờ `--model` của Claude, chỉ là cờ có mặt, không có danh sách model).
- Trên máy này: `claude` 2.1.316 (`~\.local\bin\claude.exe`), `codex-cli` 0.165.0 (npm shim `codex.cmd`); không có `gemini`, `ollama`. Khớp với ASSUMPTIONS #13/#14 (Claude 2.1.316 và 2.1.314, Codex 0.165.0).

## 2026-11-04 — CI, quét CLI, redaction, phương hướng

**Đã xong**

- CI `52660f3` (run `41736953160`) xanh đủ 5 job; job Security (secret scan + pnpm audit + cargo audit) xong lúc 23:51:05Z, mất khoảng 41 phút (lần trước cả run chỉ ~16 phút).
- Đã push đến `1009755`: gỡ adapter giả `stub` khỏi `agents.list` (vẫn đăng ký cho `runStub`, selftest, CI spike); đối chiếu roadmap; làm mới "Việc mở".
- Roadmap: **bỏ Gemini**. Phase 3 thành "Quét CLI & Local AI": quét CLI theo danh sách khai báo bằng dữ liệu, `AntigravityAdapter` (lệnh `agy`) chỉ sau khi probe thật, Ollama giữ nguyên (`0e5d80c`).
- Kiểm 7A trong app Tauri thật: lịch sử/lọc, tìm log, thẻ "Needs your decision" + `resolveReconciliation`, restart không mất dữ liệu đều đạt (`593e153`, phiên chạy ngầm, không dùng chuột/bàn phím người dùng).
- Redaction: che giá trị secret đã nạp trong message/log/phản hồi IPC, test `sidecar-redaction.test.ts` (`3a9a85b`). Giới hạn: chỉ che theo giá trị chính xác; secret bị biến đổi hoặc cắt giữa hai chunk thì không đảm bảo.
- Quét CLI: `packages/cli-probe` (candidates, scan), IPC `agents.scan`, danh sách CLI trong Settings → Agents, fixture `agy` 1.4.8 (`3921c86`, `db4e715`), gộp vào nhánh hiện tại bằng `2380045`.
- Kiểm sau gộp: lint, typecheck, prettier, 44 file / 383 test, `cargo test` 12 qua + 1 bỏ qua.

**Trên máy này**

- `claude` 2.1.316, `codex-cli` 0.165.0, `agy` (Antigravity CLI) 1.4.8; `copilot` chỉ là shim của VS Code; không có `gemini`, `ollama`.
- App chỉ chạy task với `claude` và `codex`; CLI khác chỉ được phát hiện ("đã phát hiện, chưa hỗ trợ").

**Nguyên nhân 403 của GitHub API**

- Hạn mức `core` của endpoint run cạn thật (Used 5000, reset 00:10:19Z) trong khi `gh api rate_limit` và `gh api user` trả bucket khác (used ~18, reset 00:55:11Z), nên `rate_limit` không đáng tin để biết endpoint run còn chỗ hay không. Nghi do nhiều bộ `gh run watch`/`gh run view` chạy song song (mặc định thăm dò 3 giây), chưa chứng minh được tiến trình nào dùng bao nhiêu.
- Cách tránh: đọc CI bằng GraphQL (`checkSuites`/`checkRuns` của commit, bucket riêng), một bộ theo dõi duy nhất, thăm dò thưa (`--interval 60` hoặc lịch hẹn), không vòng lặp.

**Phương hướng tiếp theo (theo thứ tự)**

1. Chờ job Security của `1009755` xanh (bắt đầu 00:08:53Z, dự kiến xong ~00:50Z), đọc bằng GraphQL, rồi push gộp một lần (HEAD `2380045`, không force). Cảnh giác: `3a9a85b` có chuỗi secret giả trong test; nếu bộ quét báo thì thêm đúng tuple đã rà soát vào `ACCEPTED_HISTORY`/`ACCEPTED_ANYWHERE`, không nới lỏng bộ quét.
2. CI Security: thêm `timeout-minutes` (gợi ý 30) cho job và tăng tốc `scripts/secret-scan.py` mà không giảm phạm vi (quét file thay đổi theo commit, cache theo blob hash hoặc chạy song song); chứng minh tương đương. Chưa làm, chờ đồng ý.
3. Phase 7 còn lại: 7C (thẻ phê duyệt cho approval do orchestrator tạo; "Luôn cho phép trong phạm vi" cần Phase 4), 7D (Tailwind/shadcn, phím tắt; thêm dependency phải pin ≥ 2 tuần, qua audit và license), preset (agent + quyền + hướng dẫn, export file), E2E người dùng mới. Chỉ khi cả ba tiêu chí đóng đạt mới viết `PHASE7_REPORT.md`.
4. Phase 3: probe thật `agy` (`--print` + `--output-format stream-json`) rồi `adapter-antigravity` + fixture + contract test; Ollama khi máy có; không bịa capability.
5. Dọn: `D:s7a-tmp` (thư mục tạm của phiên kiểm 7A) và credential `index/claude.agent-studio` (danh sách tên secret của app, tàn dư kiểm thử) trong Credential Manager.

**Việc mở / chưa xác minh**

- CI của các commit sau `1009755` (gồm `2380045`) chưa chạy.
- `cargo audit` cục bộ chưa cài (CI đã chạy và qua ở `52660f3`).
- Màu hộp Check mới chưa xem lại trong app; `pnpm build` và `clippy` chưa chạy lại sau khi gộp quét CLI.
- `README.md` và `CLAUDE.md` còn nhắc Gemini (chỉ roadmap đã bỏ).
- Nhánh `claude/phase-2-kickoff-8a5732` là bản Phase 2 cũ, xung đột add/add với nhánh hiện tại; khuyến nghị không gộp.

## Đổi tên hiển thị

- Tên hiển thị của app đổi từ "Agent Studio" sang "Team workspace" (`cb1ed4d`), rồi chốt là **"Agent Workspace"** và đồng bộ ở giao diện (productName, tiêu đề cửa sổ, `index.html`, Header, About, thông báo) lẫn tài liệu (README, CLAUDE.md, docs/). Giữ nguyên `identifier` `dev.agentstudio.desktop`, tên package `@agent-studio/*` và service Credential Manager `agent-studio`, vì đổi chúng sẽ làm mất dữ liệu và secret đã lưu của người dùng hiện có.

## 2026-11-04 (chiều) — Đưa nhánh gốc lên mới nhất

- `claude/loving-lovelace-32lh71` (nhánh gốc, `origin/HEAD`) đang ở `b8a102c` (Phase 1), chậm 52 commit so với `claude/repo-current-status-acfd51` và là tổ tiên trực tiếp nên chỉ cần fast-forward.
- Kiểm trước khi push: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` đều qua (44 file, 383 test). `clippy` và `cargo test` không chạy lại lần này.
- Commit `babca05` (thêm `docs/HANDOFF.md`) được push lên cả hai nhánh, không force; checkout chính `D:/Idea/AI_AGENT_PLATFORM` pull fast-forward về `babca05`.
- PR #1 đã tự chuyển sang MERGED lúc 02:49:21Z sau khi hai nhánh trùng nhau, nên không đóng thủ công được.
- Chưa đọc CI của `babca05` và các commit sau `1009755`.

## 2026-11-04 (tối) — Tăng tốc quét secret, làm mới tài liệu, review chéo

- `868daef` (đã format lại Prettier) xanh 5/5 job; `babca05` đỏ chỉ vì Prettier lệch ở `docs/HANDOFF.md`.
- `da9717f`: `scripts/secret-scan.py` quét lịch sử theo cặp (blob, path) thay vì từng snapshot commit; thêm `timeout-minutes: 30` cho job Security. Chứng minh tương đương: tập finding lịch sử bản cũ và bản mới đều 173 mục, giống hệt sau khi chuẩn hoá dấu phân cách đường dẫn; chạy trên Windows 7 phút xuống 38 giây.
- `326b09a`: làm mới `README.md`, `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, `docs/TODO.md` (bỏ "Phase 0", ghi trạng thái hiện tại, Ollama hoãn vì máy chưa cài).
- `bfbe920`: sửa theo review (nhận khoá đường dẫn tuyệt đối lẫn tương đối, dừng rõ ràng khi thiếu blob do clone nông, chỉnh docstring). Quét lại không mất mục nào của bản cũ; số mục tăng 173 lên 177 chỉ do hai commit mới.
- Review chéo: `/code-review medium` (7 finding nhỏ, không lỗi chặn) và `/security-review` (không finding đạt ngưỡng). Cả hai chỉ đọc mã.
- Kiểm: `pnpm lint`, `format`, `typecheck`, `test`, `build` qua; `cargo clippy -D warnings` sạch; `cargo test` 12 qua, 1 bỏ qua.
- Đã push `868daef..bfbe920` lên `claude/repo-current-status-acfd51`. Nhánh gốc vẫn ở `868daef`.
- Dọn A5: `D:\as7a-tmp` và credential `index/claude.agent-studio` đã được người dùng xoá. Không còn mục `agent-studio` nào trong `cmdkey /list`. Đã đối chiếu `secrets.rs`: đó là chỉ mục tên secret do app tạo, không mất dữ liệu người dùng (người dùng chưa nhập secret nào); Settings hiện danh sách rỗng, không lỗi.

**Việc mở**

- Đọc CI của `bfbe920` (GraphQL). Rủi ro: định dạng khoá đường dẫn của detect-secrets trên Linux chưa được chạy thử; thời gian job Security mới và dung lượng thư mục tạm chưa có số đo trên CI.
- A7 (`cargo audit` cục bộ), A8 (màu hộp Check trong app thật), B6 (nợ UI: Open log, Newer/Older nhiều trang, bố cục hẹp, theme).
- Sau đó: fast-forward nhánh gốc, rồi Đợt 2 (B1 kiểm CLI thật, B2 phần 7C-1 và `ApprovalScope`).

## 2026-11-04 (đêm) — Fast-forward nhánh gốc, A7, probe agy, kiểm UI A8+B6

- Nhánh gốc `claude/loving-lovelace-32lh71` fast-forward `868daef` tới `3d5925f` (không force). CI `3d5925f`: TypeScript (ubuntu, windows), Tauri và một lượt Security (bản quét mới, lần đầu trên Linux) xanh; lượt còn lại lúc ghi chưa xong.
- A7: `cargo audit` 0.22.2 cục bộ, 424 crate, không lỗ hổng; hai cảnh báo transitive: `proc-macro-error` không bảo trì (RUSTSEC-2024-0370), `glib 0.18.5` unsound (RUSTSEC-2024-0429).
- Probe `agy` 1.4.8 (2 trong 3 lượt gọi model): sự kiện `init`/`step_update`/`result`, usage 25 611 token cho lượt tối thiểu; `--mode plan` thoát 0 với `result` rỗng sau print timeout (commit `79dbf42`, fixture + `docs/ASSUMPTIONS.md`). Chưa có adapter.
- Kiểm UI trong app Tauri thật (debug build, WebView2 + CDP, DB tạm, 65 task seed, không chạy task thật):
  - A8 hộp Check: đạt cả sáng/tối (tương phản khoảng 4,6 sáng, 6,3 tối; hộp lỗi 5,2–5,4).
  - B6: phân trang 30/30/5 đúng thứ tự, Newer/Older đúng trạng thái; Open log đúng 7/7 dòng; không tràn ngang ở 1100/800/700/600 px; cả 5 màn hình đọc được ở hai theme.
  - Phát hiện: chữ trắng trên accent tối `#4493f8` chỉ 3,10:1 (logo, avatar, nút primary), dưới 4,5; sidebar < 800 px bị giới hạn 50vh nên danh sách project bị cắt ở chiều cao 720; nút Older vẫn bật khi tổng là bội số của 30 (suy ra từ mã, chưa test); lịch sử chỉ hiện ngày, không giờ. Tương phản accent tối đã sửa (`--accent-fg` tối, 6,11:1); chưa kiểm Settings > Agents Save/Use defaults và Peer Review với CLI thật.

## 2026-11-04 (khuya) — Push, fast-forward lần hai, sửa tương phản

- `1540a4f` (`fix(desktop)`): `--accent-fg` của theme tối đổi từ trắng sang `#0d1117`; tương phản trên accent `#4493f8` từ 3,10:1 lên 6,11:1 (tính bằng công thức WCAG). Chạy `pnpm lint`, `typecheck`, `build`, Prettier: qua. `pnpm test` không chạy lại sau thay đổi này; chưa nhìn lại trong app thật.
- Có commit `6547f6c` (ADR-005, chốt lại thứ tự phase, sửa `DECISIONS.md`, `ROADMAP.md`, `TODO.md`) do phiên khác tạo trong cùng worktree; không do phiên này viết.
- Đã push `3d5925f..1540a4f` lên `claude/repo-current-status-acfd51`, rồi fast-forward nhánh gốc `claude/loving-lovelace-32lh71` từ `3d5925f` lên `1540a4f` (không force).
- CI `1540a4f`: tại lần đọc cuối (16:00 UTC) cả 5 job (mỗi job hai lượt push + pull_request) còn QUEUED; chưa có kết luận. Phiên con `ci-read-1540a4f` đang đọc tiếp.

## 2026-11-04 (khuya, phiên phụ) — Sắp lại phase, rà A5, tham khảo Spec Kit, skill `/save`

- ADR-005 (`6547f6c`, đã push): đổi thứ tự phase để hết vòng phụ thuộc (7C cần Policy Engine của Phase 4; Phase 8 cần `mcp-gateway` của Phase 6 và Policy Engine; Phase 9 cần Policy Engine). Thứ tự mới: Phase 7 (phần không cần policy) song song Phase 3 → Phase 4 (+ 7C-2, đóng Phase 7) → Phase 5 → Phase 6 → Phase 8 → Phase 9; Phase 10 xuyên suốt.
- Bộ quét secret theo cặp (blob, path): hai lượt chạy khớp 173 = 173 phát hiện lịch sử; cũ ~7 phút, mới ~38 giây trên Windows. Hai bản review (`/code-review medium`, `/security-review`) không có vấn đề chặn.
- Rà dọn A5: xem mục 2026-11-04 (đêm) ở trên, đã sửa lại kết luận (không phải credential thừa).
- Đọc github/spec-kit v1.3.0 (MIT) chỉ để so sánh thiết kế, không sao chép, không clone, không chạy. Ý có thể dùng: "một thao tác, nhiều adapter", catalog chỉ để khám phá và phải xác nhận tin cậy tường minh trước khi chạy mã (liên quan Phase 8), workflow lưu cây thực thi và resume từ PAUSED/FAILED.
- Tạo skill cá nhân `/save` (`~/.claude/skills/save`, ngoài repo) để ghi tiến trình vào HANDOFF/PROGRESS/TODO/ROADMAP/DECISIONS và tạo file thiếu từ mẫu; đã ghi vào `~/.claude/skills-registry.md`. Chưa thử gọi thật (cần phiên mới để nhận skill).
- Chưa làm: cập nhật `CLAUDE.md` (Tailwind/shadcn ghi "đã chốt" nhưng chưa có; trỏ tới ADR-005).

## 2026-11-04 (khuya, B1) — Kiểm resume Peer Review với CLI thật

- Chạy `node scripts/e2e-peer-review.mjs resume claude codex` và `resume codex claude` (CLI thật, có tốn usage, DB/repo tạm): cả hai lần kill → task `needs_reconciliation` → quyết định `requeue` → hai task `completed`, workflow `completed`, exit 0. Lần claude→codex in thêm "cleanup skipped: EPERM" (dọn thư mục tạm, không ảnh hưởng kết quả).
- Chưa chạy: qua UI app Tauri thật; CI `1540a4f` còn chưa đọc kết luận; `3dab1ef` chưa push.

## 2026-11-04 (khuya, 7C-1) — Approval: nhật ký, timer, phạm vi bị khoá

- Thêm migration `0006_approval_decision_log`: cột `decided_by`, `decision_scope`, `decision_note` cho `approvals`; bảng `approval_grants` (chỉ schema, chưa có mã nào đọc/ghi).
- `ApprovalScope` (`once|task|project|path|command`) trong contracts; `approvals.resolve` nhận `scope` mặc định `once`, service từ chối mọi phạm vi khác (fail closed, yêu cầu vẫn pending). Không thêm method IPC mới nên `lib.rs`/stub không phải đổi.
- Timer quét hết hạn 5 giây trong sidecar (`approvalSweepMs`, dừng ở `close()`): quá hạn → `expired`, task → `needs_reconciliation` (giữ hành vi Phase 2, không chuyển `denied`).
- UI: thẻ phê duyệt có thời điểm hỏi/hết hạn, ô ghi chú, "Allow once" / "Deny", nút "Always allow in scope" bị khoá kèm lý do; mục Decision log (20 mục gần nhất).
- Kiểm: `pnpm lint`, `typecheck`, `test` (44 file, 389 test), `build` qua. Chưa kiểm trong app Tauri thật. Vẫn chưa có đường production tạo approval từ CLI thật (Phase 4), nên thẻ chỉ xuất hiện khi mã gọi `ApprovalService.request`.

## 2026-11-04 (khuya, kiểm UI app thật sau 7C-1 và dọn UI)

- Build lại sidecar và app debug, chạy WebView2 + CDP, DB tạm (69 task seed + 4 approval seed qua kết nối SQLite thứ hai), không chạy CLI thật.
- Thẻ phê duyệt (7C-1): hiện mô tả, giờ hỏi/hết hạn, ô ghi chú; "Allow once", "Deny" bật, "Always allow in scope" bị khoá (opacity 0,5, tooltip nêu Phase 4). Deny kèm ghi chú ghi đúng vào DB (`decided_by=user`, `decision_scope=once`, `decision_note`), task chuyển `failed`. Decision log hiện đủ approved/denied/expired, đạt ở theme sáng và tối.
- Hết hạn: approval quá hạn thành `expired`, task thành `needs_reconciliation`. Lưu ý: UI poll `approvals.list` mỗi 1,5 giây và `list` cũng gọi `expireDue`, nên lần chạy này chưa tách riêng được timer 5 giây; timer chỉ được chứng minh bằng test đơn vị.
- Phát hiện và đã sửa: thẻ phê duyệt bị ép trong một hàng flex (nút khoá rớt thành 4 dòng); thêm `.approval-card` dạng cột, nút một dòng (kiểm lại ở hai theme).
- Dọn UI: History phân trang 30/30/9 đúng, Older tắt ở trang cuối; ngày cũ hiện kèm giờ ("Sep 30, 2026 07:39 PM"); sidebar ở 700×720 không còn bị cắt (`max-height: none`). Trường hợp đúng 30 hàng chỉ kiểm bằng test đơn vị.
- Phát hiện chưa sửa: danh sách "What happened?" trong thẻ reconciliation (7A) xếp radio và nhãn thành cột dọc, trông lỏng; không ảnh hưởng chức năng.
- Chưa kiểm: Settings > Agents Save/Use defaults; Peer Review chạy CLI thật qua UI.

## 2026-11-04 (khuya, push và CI)

- Push `1540a4f..f75a72b` lên `claude/repo-current-status-acfd51`, rồi fast-forward nhánh gốc `claude/loving-lovelace-32lh71` lên `f75a72b` (không force). Gồm: `98e28c5`, `f81f20f` (B1), `bf7ba01` (dọn UI), `52d489d` (7C-1), `f75a72b` (bố cục thẻ phê duyệt, ghi kiểm UI thật).
- CI `1540a4f` (đọc bằng GraphQL): xanh cả 10 check run; Security 7,1 phút (push) và 5,9 phút (pull_request) so với khoảng 41 phút trước.
- CI `f75a72b`: lúc đọc cuối còn IN_PROGRESS/QUEUED, chưa có kết luận.

## 2026-11-04 (đêm, tích hợp hai luồng song song)

- Hai phiên con chạy song song trong worktree riêng, rồi được gộp vào `claude/repo-current-status-acfd51` bằng merge commit: Phase 7 UI (`c2fef0a` radio thẻ ngang, `6b2f4c6` preset "assistant" + export/import, `d0a3565` phím tắt cơ bản, `2d73308` docs) → `48ff83e`; Phase 3 (`efa3a47` adapter `agy`, `623fb75` đăng ký vào sidecar, `d0e43b0` capability router, `ddfbf9f` PHASE3_REPORT + ASSUMPTIONS) → `7275822`.
- Kiểm sau merge trên cây `7275822`: `pnpm install --frozen-lockfile`, `lint`, `prettier --check`, `typecheck`, `build` qua; `pnpm test` 48 file / 433 test qua (một lần chạy giữa chừng có 1 test `sidecar-resume` hết 5 giây khi máy tải, chạy lại qua); `cargo clippy --all-targets -- -D warnings` sạch, `cargo test` 12 qua / 1 bỏ qua.
- Đã push `759aca6..48ff83e` rồi `48ff83e..7275822` lên nhánh làm việc. Nhánh gốc `claude/loving-lovelace-32lh71` chưa được fast-forward.
- Chưa làm / chưa xác minh: CI của `48ff83e` và `7275822` (phiên `ci-read-48ff83e` đang đọc, chưa có kết luận); `agy` thật chưa chạy qua adapter (lượt probe thứ 3 cần người dùng cho phép); UI preset, phím tắt, thẻ radio chưa kiểm trong app Tauri thật; Tailwind/shadcn chưa làm (cần duyệt dependency).

## 2026-11-04 (đêm, push docs và mở PR #2)

- Push `7275822..a4d8c86` (commit `a4d8c86` docs: record night progress) lên `claude/repo-current-status-acfd51`; mở PR #2 vào `claude/loving-lovelace-32lh71` (12 commit, 32 file). `mergeable`: MERGEABLE; chưa merge.
- CI: `7275822` TypeScript ubuntu và windows xanh, Tauri/Security/spike còn chạy lúc đọc cuối; PR #2 có 10 check đang chờ, chưa có kết luận.

## 2026-11-04 (đêm, cập nhật CI)

- CI `7275822` (phiên con đọc bằng GraphQL): TypeScript ubuntu (1 phút 26 giây), TypeScript windows (2 phút 25 giây), Tauri shell (5 phút 13 giây), spike sidecar (5 phút 27 giây) đều xanh; Security còn IN_PROGRESS, chưa có kết luận.
- Commit docs `cdd2c06` chưa push.

## 2026-11-04 (đêm, CI cuối và điều tra flaky)

- Push `a4d8c86..a3f9d20` (hai commit docs) lên PR #2. CI `7275822` xanh 5/5 (phiên con đọc). `48ff83e`: TypeScript ubuntu đỏ do `scheduler.test.ts` timeout 5000ms (phiên con đọc log), không liên quan Phase 7 UI.
- Tái hiện cục bộ: `vitest run scheduler.test.ts` 40 lần (8 luồng song song × 5), 40/40 qua. Vitest 5.0.5 không có cờ `--repeat`. Chưa sửa mã, chưa nới timeout.
- CI của PR #2 sau hai commit docs: chưa đọc.

## 2026-11-04 (khuya, kiểm UI Phase 7 trong app Tauri thật)

- Kiểm trên `550e54b` (đã gồm preset, phím tắt, thẻ radio ngang): debug build `pnpm tauri build --debug --no-bundle`, WebView2 + CDP (phím/click gửi qua CDP, không dùng chuột/bàn phím người dùng), DB tạm và sidecar ngoài repo, seed project/workflow/task `needs_reconciliation` qua kết nối SQLite thứ hai sau khi app chạy (workflow `paused`, không có task `queued`). Không chạy CLI thật; Save ở Agents chỉ chạy `--version`/`--help`.
- Đạt: Presets (preset `assistant` có sẵn trong ô Preset của Agent view cùng preset cục bộ; tạo/sửa/xoá; lưu localStorage, còn sau reload; export; import báo đúng lỗi JSON sai, id trùng `assistant`, bỏ qua id trùng). Phím tắt Ctrl+1/2/H/`,`/Shift+N hoạt động kể cả khi textarea đang focus; Alt+Ctrl không kích hoạt; Ctrl+Enter chỉ gửi form khi có nội dung (chặn submit bằng listener, không tạo task). Thẻ "What happened?" xếp 4 thẻ ngang ở 1100 px, hai theme; chọn radio, ô xác nhận "Run it again" và nút Confirm bị khoá đúng. Agents Save/Use defaults: lệnh không tồn tại bị từ chối, `claude` lưu được và còn sau reload, Use defaults xoá và `agent_settings` rỗng.
- Lỗi/đề xuất (chưa sửa): (1) Ở < 650 px với một session đang mở (Peer Review có thẻ reconciliation), trang tràn ngang (scrollWidth 644 so với 585 ở 600 px), header và nội dung bị cắt; cột grid `1fr` trong `@media (max-width: 800px)` cần `minmax(0, 1fr)`. (2) Ở 700 px thẻ "Run it again" rớt xuống hàng hai và chiếm hết chiều ngang. (3) Presets: textarea Export/Import hẹp (~170 px) không full width, hàng danh sách preset lệch lề; preset `assistant` không hiện trong danh sách Presets (chỉ có chú thích). (4) Chưa kiểm cách Ctrl+Enter gửi thật (cần CLI), DiffViewer với worktree thật, và tương phản chữ muted ở theme tối bằng số liệu tin cậy (muted sáng #59636e trên trắng tính tay khoảng 6,1:1).

## 2026-11-04 (khuya, kiểm bằng mắt bố cục và UI capability thiếu trong app Tauri thật)

- Kiểm trên `51a42b4` (gồm `e7737ba`): debug build `pnpm tauri build --debug --no-bundle`, sidecar đóng gói và DB tạm ngoài repo, WebView2 + CDP cổng cục bộ (viewport đặt bằng `Emulation.setDeviceMetricsOverride`, theme bằng `data-theme`; không dùng chuột/bàn phím người dùng), chạy ngầm, đã tắt app sau khi kiểm. Seed project + workflow `paused` với 2 task (implementer `completed`, reviewer `needs_reconciliation`) bằng kết nối SQLite thứ hai, run lưu trong localStorage. Không chạy CLI thật (không bấm Run/Start review); ảnh chụp để trong scratchpad của phiên, không commit.
- **Bố cục, session Peer Review có thẻ reconciliation: đạt.** `scrollWidth` bằng `clientWidth` ở cả hai theme: 585/585 ở 600 px, 685/685 ở 700 px, 1100/1100 ở 1100 px (trước khi sửa: 644 so với 585 ở 600 px). Header ở 600 px xuống hai dòng ("Agent Workspace", "proj /" bị cắt gọn), không tràn.
- **Thẻ "Run it again" ở 700 px: đạt.** 4 thẻ radio cùng một hàng, mỗi thẻ rộng 150 px cao 94 px (trước: rớt xuống hàng hai, chiếm cả chiều ngang). Ở 600 px xếp 3 + 1 (mỗi thẻ 164 đến 169 px), không tràn.
- **Settings → Presets: đạt.** Ô Export/Import rộng 610 px bằng đúng bề rộng trong thẻ (card 640 px, padding 15 px) ở 1100 và 700 px, hai theme. Hàng danh sách cùng lề trái (x = 363 ở 1100 px) cho preset built-in và preset cục bộ, nút Edit/Delete căn phải. Preset `assistant` hiện trong danh sách là "assistant · built in", chỉ đọc (không có Edit/Delete).
- **UI capability thiếu, Peer Review: đạt.** `agy` có trên máy nên `detect()` đúng; adapter báo `streaming`, `structured_output`, thiếu `tool_execution`. Danh sách Implementer/Reviewer hiện "agy (thiếu capability)". Chọn `agy` ở Implementer, ở Reviewer, hoặc cả hai: "Start review" bị khoá (disabled) kèm dòng cảnh báo "agy không hỗ trợ: chạy công cụ" (cả hai theme); Ctrl+Enter trong ô Goal không tạo workflow (DB giữ nguyên 1 workflow/2 task); quay về claude/codex thì nút mở lại, dòng gợi ý là "Ctrl+Enter to run". Mặc định chọn claude/codex, không chọn `agy`.
- **UI capability thiếu, AgentView: không kiểm được.** Cần agent thiếu `streaming`, mà không adapter đã đăng ký nào thiếu (`agy` có `streaming`): chọn `agy` ở Agent view thì Run vẫn mở (đúng). `agents.list` lấy capability từ chính adapter, không từ bảng `agents` (probe chỉ để hiện trong Settings), nên seed bảng `agents` không thay đổi được kết quả. Nhánh này mới chỉ có unit test (`capabilityGap.test.ts`).
- Quan sát nhỏ, chưa sửa: ở Peer Review mới (chưa có run) đoạn giải thích dưới "Start a Peer Review" lệch lề trái so với khung các bước (chữ bắt đầu x ≈ 266, khung x ≈ 521 ở 1100 px). Chưa so với bản trước nên không biết có phải lỗi mới.
- Kết luận: cả hai phần đạt (trừ nhánh AgentView nêu trên), tick dòng "UI hiển thị capability thiếu" trong `docs/TODO.md`. Không sửa mã nguồn.

## 2026-11-05 (phiên cloud, Linux): Policy Engine thuần + sửa CLAUDE.md

- Nhánh `claude/dreamy-faraday-29xjfj` tạo từ `6fe3839` (nhánh `claude/repo-current-status-acfd51`); không push vào nhánh gốc, không tạo PR, không bật auto-merge. Chưa push nhánh này lúc ghi mục này.
- `CLAUDE.md`: dòng Stack ghi Tailwind/shadcn + Zustand + TanStack Query là "kế hoạch Phase 7D, chưa có" (cả ba đều không có trong repo); quy tắc 10 trỏ tới ADR-005 về thứ tự phase.
- Gói mới `packages/policy-engine` (`@agent-studio/policy-engine`): `evaluate()` fail-closed trả `allow | ask | deny`; path scope canonical (`..` sau symlink, symlink treo, vòng symlink, tương đối, NUL), command policy (allow khớp chính xác, deny cả theo tên, chặn shell), network policy (host chuẩn hoá, wildcard chỉ tên con, cổng), 4 mức quyền, và hợp đồng grant cho 7C-2 (`ctx.grants`, `grantTargetFor`; `GrantScope` suy từ `ApprovalScope`). Không thêm dependency ngoài; lockfile chỉ thêm importer. Ngữ nghĩa các mức và phạm vi grant là quyết định thiết kế chờ người dùng duyệt (ASSUMPTIONS, mục Phase 4).
- Giao diện 7C-2 cần: (1) khi agent/orchestrator xin quyền, dựng `PolicyRequest` và gọi `evaluate`; `ask` mang `target` để lưu; (2) `approvals.resolve` với scope ≠ `once`: gọi `grantTargetFor(scope, ask, ctx)`, `null` thì từ chối scope; ghi `approval_grants`; (3) lần sau truyền các grant còn hiệu lực qua `ctx.grants`. Chưa làm: không sửa `src-tauri`, `contracts`, sidecar hay UI.
- Kiểm chứng (Linux/Node 22.23.4/pnpm 10.28.0): `pnpm install --frozen-lockfile` qua (sau khi cập nhật lockfile cho importer mới); `pnpm lint`, `pnpm exec prettier --check .`, `pnpm typecheck`, `pnpm build` qua; `pnpm test`: 51 file, 482 test qua, 2 bỏ qua (có sẵn từ trước: baseline 441 qua, 2 bỏ qua; thêm 41 test của gói này, không cái nào bị bỏ qua, symlink tạo được). Đột biến thử (gộp `..` theo từ vựng) làm đúng 2 test đỏ rồi đã khôi phục. Lần đầu có 2 test đỏ do chính test dùng `path.join` (tự gộp `..`), đã sửa test chứ không sửa mã.
- Chưa chạy: mọi thứ trên Windows (symlink/junction/UNC/8.3/ADS, so sánh hoa-thường); `cargo clippy -D warnings` và `cargo test` (không có Rust trên cloud; `src-tauri` không đổi nên kết quả lần trước còn nguyên nhưng chưa chạy lại); Job Object và Credential Manager thật; CI trên GitHub (chưa push); kiểm trong app Tauri thật (không có thay đổi UI).

## 2026-11-05 (Windows): ghép nhánh cloud và kiểm lại

- Ghép `origin/claude/dreamy-faraday-29xjfj` (`66f4be3`: Policy Engine thuần, sửa `CLAUDE.md`, ghi chú ASSUMPTIONS/SECURITY/TODO) vào `claude/repo-current-status-acfd51` bằng merge commit `c85d130`, không xung đột. Nhánh đứng trước `origin` 4 commit; CHƯA push.
- Kiểm trên Windows (pnpm 10.28.0): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm exec prettier --check .`, `pnpm typecheck`, `pnpm build` qua. `pnpm test`: 482 qua, **2 ĐỎ** (51 file, 49 qua), cả hai của gói mới:
  - `packages/policy-engine/src/paths.test.ts` "resolves .. after a symlink against the link TARGET, not lexically".
  - `packages/policy-engine/src/engine.test.ts` "denies ../ that escapes only because of a symlink": `evaluate` trả `allow` thay vì `deny`.
- Nguyên nhân (suy luận, chưa chứng minh): `canonicalize` dựa vào `fs.realpath` với `..` giữ nguyên, kiểu POSIX (`..` sau symlink đi tới cha của đích). Trên Windows, Win32 gộp `..` theo từ vựng trước khi mở file nên `ws\link\..\x` thành `ws\x`; kết quả khác Linux. Hai test này chỉ chạy được khi tạo được symlink, nên cloud (Linux) thấy xanh. Điều đó khớp ghi chú trong ASSUMPTIONS rằng Windows chưa kiểm. Mức rủi ro thật chưa rõ: tiền tố `\?\` không gộp `..`, nên cần quyết định hành vi cho Windows (xem HANDOFF).
- Lần chạy `pnpm test` đầu tiên có 1 test khác đỏ: `packages/process-manager` "cancels via AbortSignal" hết 30000ms. Chạy riêng `packages/process-manager` 2 lần: 20/20 qua cả hai. Nghi flaky khi máy tải, chưa điều tra, chưa nới timeout.
- Chưa chạy: `cargo clippy -D warnings` và `cargo test` (`src-tauri` không đổi); CI trên GitHub cho `c85d130` (chưa push); kiểm trong app Tauri thật (không đổi UI); junction/UNC/8.3/ADS/tên thiết bị cho Policy Engine.

## 2026-11-05 (Windows): sửa `..` của Policy Engine theo Win32

- Quyết định của người dùng: theo Win32. `packages/policy-engine/src/paths.ts`: trên Windows `canonicalize` gộp `..` trước (`path.normalize`) rồi `realpath`; từ chối đường dẫn bắt đầu bằng `\?\` hoặc `\.\` (cả dạng `//?/`). POSIX giữ nguyên.
- Test: hai test đỏ tách theo nền tảng (POSIX giữ nguyên kỳ vọng, Windows kỳ vọng gộp từ vựng) và thêm 2 test Windows (đường dẫn verbatim/device bị từ chối ở `canonicalize` và `evaluate`). Trên Windows 2 test POSIX bị bỏ qua đúng thiết kế.
- Kiểm trên Windows: `pnpm lint`, `prettier --check .`, `typecheck`, `build` qua; `pnpm test`: 51 file, 485 qua, 2 bỏ qua, 0 đỏ (`process-manager` không timeout lần này). Chưa chạy lại trên Linux (đợi CI). `cargo clippy`/`cargo test`: chưa chạy. Chưa push.

## 2026-11-05 (phiên cloud, Linux): nối capability router vào `workflows.start`

- Nhánh `claude/gracious-ritchie-ut3238` tại `3db3aa9` (= `claude/loving-lovelace-32lh71`); không push vào nhánh gốc, không tạo PR, không bật auto-merge. Chưa commit/push lúc ghi mục này.
- Hướng làm: KHÔNG thêm method IPC. Trong Zod variant có sẵn của `workflows.start`, `agentId` thành tùy chọn (`packages/contracts/src/index.ts`). Bỏ trống: `sidecar.ts` gọi `snapshotAdapters` + `selectAgent` với yêu cầu `["streaming"]` (cùng yêu cầu `AGENT_TASK_REQUIRES` của UI), loại `stub`; thứ tự đăng ký quyết định khi nhiều agent đủ điều kiện (claude, codex, agy, rồi adapter thêm). Không agent nào đủ → lỗi tiếng Việt từ `describeRouteFailure` (hàm mới trong `capability-router.ts`, gom `describeCapabilityGap` của từng agent) và không tạo task. Chỉ định `agentId` rõ: hành vi cũ (chỉ kiểm tồn tại), vì nhiều adapter test khai báo `capabilities: []` và UI đã chặn phía client.
- Vì không đổi tên method nên KHÔNG sửa `src-tauri/src/lib.rs` (không cần `cargo clippy`/`cargo test` thêm cho thay đổi này), `ALLOWED_METHODS` và `preview-sidecar.ts` giữ nguyên (stub preview vốn bỏ qua `agentId`). `apps/desktop/src/api.ts` vẫn luôn gửi `agentId`, nên **người dùng chưa thấy khác biệt gì trong UI**; đường mới chỉ chạy khi client bỏ trống `agentId`.
- Test mới `services/orchestrator/src/sidecar-routing.test.ts` (5 test) + 2 test `describeRouteFailure`: chọn theo capability bỏ qua agent không sẵn sàng/không streaming đăng ký trước; route tới `AntigravityAdapter` chạy `fake-agy.mjs` (id `agy-fake`) chạy xong `completed`; lỗi nêu thiếu gì và không tạo task; không bao giờ chọn `stub`; `agentId` rõ vẫn chạy và `ghost` vẫn `Unknown agent`. Test đặt `PATH` rỗng (`vi.stubEnv`) và khẳng định `claude`/`codex`/`agy` thật không sẵn sàng trước khi chạy, nên không thể khởi động CLI thật trên máy có cài.
- Kiểm chứng (Linux, pnpm 10.28.0): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm exec prettier --check .`, `pnpm typecheck`, `pnpm build` qua; `pnpm test`: 52 file, 489 qua, 5 bỏ qua, 0 đỏ (chưa đo baseline số bỏ qua trên Linux trước thay đổi). Chạy `prettier --write` trên cả thư mục từng làm lệch 3 file không liên quan; đã hoàn nguyên bằng `git checkout`, `prettier --check .` toàn repo qua.
- Chưa chạy: mọi thứ trên Windows; `cargo clippy -D warnings`/`cargo test` (không cần cho thay đổi này vì `src-tauri` không đổi, nhưng chưa chạy lại); `agy` thật qua đường tự chọn; kiểm trong app Tauri thật (không đổi UI); CI GitHub (chưa push).
- Việc người dùng nên kiểm trên Windows: fetch nhánh, chạy lại chuỗi kiểm chứng đầy đủ; với `claude`/`codex`/`agy` thật cài sẵn, gọi `workflows.start` không `agentId` (vd. qua `preview-sidecar` không dùng được, cần client gọi sidecar thật) và xác nhận agent được chọn đúng thứ tự `claude` → `codex` → `agy` và lỗi khi không có CLI nào. Quyết định chờ người dùng: UI có cần mục "Auto" không, và có muốn backend kiểm capability cả khi `agentId` chỉ định rõ không (sẽ làm vỡ các test dùng adapter không khai báo capability).
- Văn bản lỗi thời còn lại (không sửa vì ngoài phạm vi yêu cầu): `docs/HANDOFF.md` (hàng Phase 3 và "Việc tiếp theo" mục 2) và `docs/PHASE3_REPORT.md` vẫn ghi router chưa nối `workflows.start`.

## 2026-11-05 (Windows, tổng kết phiên): ghép nhánh, dọn worktree, phiên con

- Ghép `repo-current-status-acfd51` vào `claude/loving-lovelace-32lh71` (`b097fdc` commit sửa chưa commit của người dùng, `3db3aa9` merge; xung đột chỉ ở hai dòng Stack của `CLAUDE.md`, giữ bản của người dùng). Push cả hai nhánh; PR #2 chuyển MERGED. Gỡ 9 worktree thừa (git báo `Filename too long` nên xóa nốt thư mục sót bằng đường dẫn `\?\`, theo cho phép của người dùng); nhánh còn nguyên.
- Phiên con (đọc bằng GraphQL và báo cáo của chúng, tôi chưa tự chạy lại): CI `3db3aa9`/`2826397` có TypeScript windows ĐỎ do 8 test `policy-engine` (tên 8.3 `RUNNER~1`); `603d6fb` (`realpathSync.native` trong `test-helpers.ts`) đã push; CI của nó: ubuntu, windows, Tauri shell, spike xanh, Security đang chạy khi đọc. Rust: `cargo clippy --all-targets -D warnings` qua, `cargo test` 12 qua/0 lỗi/1 ignored.
- Flaky `process-manager` "cancels via AbortSignal": không tái hiện (khoảng 680 lượt, kể cả dưới tải), không sửa mã; ghi chú ở `cf97850` trên `claude/fix-pm-abort-flaky-7e3a1f`, chưa push, chưa ghép.
- Hai phiên cloud đã push nhánh nhưng chưa ghép: `claude/gracious-ritchie-ut3238` (`ba05f5b`: `workflows.start` chọn agent theo capability khi bỏ trống `agentId`, đổi `contracts` và `sidecar.ts`, test `sidecar-routing`, không sửa `lib.rs`) và `claude/fervent-thompson-u83u2i` (`d6456b0`: `packages/resource-monitor` và hook admission ở `scheduler.ts`, 295 dòng test). Kiểm bằng `git merge-tree`: mỗi nhánh merge sạch vào nhánh chính; hai nhánh với nhau XUNG ĐỘT (chưa xem file). Chưa chạy lint/test/build của hai nhánh này; nhánh resource-monitor không cập nhật PROGRESS/TODO/ASSUMPTIONS như brief.
- Chưa làm: ghép hai nhánh cloud, đọc kết luận Security của `603d6fb`, chạy `agy` thật, Tailwind/shadcn, Playwright, nối 7C-2 (chờ người dùng duyệt).

## 2026-11-05 (phiên cloud, Linux): Resource monitor thuần (Phase 3)

- Nhánh `claude/fervent-thompson-u83u2i` tạo từ `3db3aa9` (nhánh `claude/loving-lovelace-32lh71`); không push vào nhánh gốc, không tạo PR, không bật auto-merge.
- Gói mới `packages/resource-monitor` (`@agent-studio/resource-monitor`, không dependency): `ResourceSource` (giả lập được) + `NodeResourceSource` (`node:os`, `process`, `/proc` cho pid khác trên Linux); `Thresholds` (cpu/memory reduceAt/pauseAt, `trackedRssReduceBytes`, `releaseMarginPercent`; `DEFAULT_THRESHOLDS` chưa được chỉnh); `decide()` thuần có hysteresis; `ResourceMonitor` (`sample()`, `start()/stop()`, `maxConcurrency(base)`: normal = base, reduced = nửa (tối thiểu 1), paused = 0).
- Móc vào `Scheduler`: thêm `SchedulerOptions.admission?: SchedulerAdmission` (`maxConcurrency(base)`), chỉ hạ được giới hạn, không vượt `concurrency`; `<= 0` thì không khởi động task mới nhưng vẫn hết hạn lease và huỷ task bị chặn; task đang chạy không bị đụng. Không có `admission` thì hành vi cũ không đổi. Orchestrator không phụ thuộc gói mới (giao diện cấu trúc).
- Không làm: nối vào sidecar/`workflows.start`, IPC, UI, settings, `src-tauri`, `policy-engine`, `process-manager`; không thêm dependency (lockfile chỉ thêm importer rỗng).
- Kiểm chứng (Linux/Node 22.23.4/pnpm 10.28.0): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm exec prettier --check .`, `pnpm typecheck`, `pnpm test` (52 file, 507 qua, 5 bỏ qua: đều là test chỉ-Windows có sẵn, không có test mới nào bị bỏ qua), `pnpm build` đều qua. 20 test mới trong gói + 5 test admission của scheduler (tổng +25 so với 482 qua trước đó).
- Chỉ chạy trên Linux: mọi test trên. Một test đọc OS thật (`NodeResourceSource` với `os` và pid của chính test) chạy trên Linux; còn nhánh `/proc` được kiểm bằng dữ liệu giả. Chưa chạy: Windows (số đo `os.cpus()`/`os.freemem()`, RSS tiến trình con trả `undefined` ở đó), Job Object, CI GitHub, `cargo`, app Tauri thật.

## 2026-11-05 (Windows): ghép hai nhánh cloud vào nhánh chính

- Router: merge `399ce07` (đã push). Resource monitor: merge `021da4d` (chưa push). Xung đột chỉ ở `docs/PROGRESS.md` và `docs/TODO.md` (cả hai bên cùng thêm vào cuối file), giữ cả hai bên; mã không xung đột. Resource monitor thêm `SchedulerAdmission` vào `scheduler.ts` (chỉ giảm giới hạn, không vượt `concurrency`).
- Đính chính: mục tổng kết trước ghi nhánh `claude/fervent-thompson-u83u2i` "không cập nhật PROGRESS/TODO/ASSUMPTIONS"; sai, nhánh có sửa cả ba (tôi đã cắt đầu ra `git diff --stat`). Nhánh chưa có `603d6fb` là đúng nhưng nay đã nằm trong nhánh chính.
- Kiểm trên Windows sau `021da4d`: `pnpm install --frozen-lockfile`, `pnpm lint`, `prettier --check .`, `typecheck`, `build` thoát 0; `pnpm test`: 53 file, 517 qua, 2 bỏ qua, 0 đỏ. Chưa chạy: `cargo clippy`/`cargo test` (không đổi `src-tauri`), CI GitHub cho `021da4d`, resource monitor trên Windows với số đo thật.

## 2026-11-05 (Windows): nút bật/tắt `agy` trong chế độ Auto

- Quyết định của người dùng: không loại `agy` khỏi tự chọn, thêm nút để người dùng tự bật/tắt (mặc định bật).
- `91317e4` (đã push): `workflows.start` nhận `excludeAgents` (chỉ khi bỏ trống `agentId`); sidecar ghép với `stub`. UI: lựa chọn "Auto (router picks)" trong ô Agent (trước đó UI luôn gửi tên agent nên router không bao giờ chạy từ UI) và ô tick trong Settings > Agents, lưu ở `localStorage`. Không thêm method IPC nên `lib.rs` không đổi.
- Kiểm: `pnpm lint`, `prettier --check .`, `typecheck`, `build` thoát 0; `pnpm test` 54 file, 520 qua, 2 bỏ qua. Chưa chạy: app Tauri thật, `cargo` (không đổi Rust).
- CI đọc qua GraphQL: `341190d` TypeScript ubuntu/windows, Tauri shell, spike ADR-001 xanh, Security đang chạy; `91317e4` mới có TypeScript ubuntu xanh, còn lại đang chạy.
