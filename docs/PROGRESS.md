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
