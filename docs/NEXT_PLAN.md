# Kế hoạch tiếp theo

## Chặng gần (soạn 2026-11-07, cập nhật theo trạng thái nhánh `worktree-p4-close-prep` @ `ad3de62`): đóng Phase 4, rồi 7C-2 và đóng Phase 7

Căn cứ: `docs/ROADMAP.md` (mục Phase 4, "Còn thiếu để đóng"), `docs/PROGRESS.md` (mục 2026-11-06 và 2026-11-07), `docs/THREAT_MODEL.md`, ADR-005. Các mục "đã xong" dưới đây lấy từ các tài liệu đó và từ gate đã chạy thật trên nhánh `worktree-p4-close-prep` (lint, format, typecheck, 847 test, build, clippy, `cargo test --locked` đều exit 0). CI thật chưa chạy trên phần này. Nhánh đó chưa nằm trong nhánh chính `claude/loving-lovelace-32lh71`.

### Giả định cần bạn xác nhận

- "Chặng gần" = Phase 4 → 7C-2 → đóng Phase 7 (đúng thứ tự ADR-005). Phase 3 (Ollama, VRAM) và Phase 5+ để sau.
- Không `git push`, không tạo PR cho tới khi bạn yêu cầu (CLAUDE.md). Bước C0 cần bạn đồng ý push.

### Đã xong (không còn trong danh sách làm)

- P4-1 c: cổng Codex `app-server` nối vào orchestrator, BẬT mặc định từ Q3 (agent thêm `codex-app-server`); kiểm với server giả và Codex thật (ASSUMPTIONS d6).
- P4-1 d: cổng Claude `--permission-prompt-tool` (kể cả `askEveryTool`, phủ Edit/Glob/Grep bằng stub), BẬT mặc định từ Q3; hướng (a) của Q1 đã chọn, giới hạn "cổng không thấy mọi lời gọi" đã ghi.
- `agent-job-wrap` nối vào process-manager, BẬT mặc định khi tìm thấy binary; watchdog RAM cả cây; trần cứng `--job-mem-limit-mb` đã đo (R4); kiểm với claude/codex thật (d9): Ctrl+C, CTRL_BREAK, kill wrapper, mã thoát 32 bit.
- P4-8 (b): engine resume Peer Review, có test cả khi reviewer bị ngắt.
- Threat model: `docs/THREAT_MODEL.md`, người dùng đã duyệt 2026-11-06.
- Tuổi gói transitive: npm 0 gói trẻ; Cargo 13 crate trẻ nằm trong allowlist có hạn (hết hạn thì CI đỏ lại).
- Soak 100 workflow với agent giả và test bảo mật; soak CLI thật 5 workflow có số liệu từng workflow; sửa lỗ symlink của artifact.
- T19: `git-worktrees` vô hiệu hoá hook/fsmonitor/diff driver của repo; R3: xác nhận 5 quyết định nhạy cảm bằng hộp thoại native.

### Thứ tự và tiêu chí (việc còn lại)

| #   | Việc                                                                                                | Tiêu chí xong (lệnh/test)                                                                                                           | Phụ thuộc / cần người dùng                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0  | Đưa nhánh `worktree-p4-close-prep` vào nhánh chính, push, đọc CI bằng GraphQL                       | CI 5/5 job xanh, Security xanh (kể cả bước kiểm tuổi gói); ghi PROGRESS với run id thật                                             | Bạn đồng ý ghép vào nhánh chính và push                                                                                                                                                                                                                                                              |
| C1  | Quyết định bật mặc định hai cổng quyền; nối `askEveryTool` và `jobMemLimitMb` vào cấu hình mặc định | Quyết định ghi ADR; nếu bật: test mặc định mới, kiểm lại Edit/Glob/Grep với claude thật; `pnpm test` + gate đầy đủ                  | **Mã/test XONG MỘT PHẦN (2026-11-07, ADR-007); kiểm chứng runtime CÒN MỞ.** Đã probe claude thật 2026-11-07 (d11): Edit/Glob/Grep, `workspace-write`, settings.local.json đối nghịch; sửa hook chạy ngoài cổng bằng `disableAllHooks`. CÒN: cổng thật bị treo, các khoá khác của settings.local.json |
| C2  | Build installer thật có `agent-job-wrap` và kiểm kill app Tauri thật khi CLI thật chạy bên trong    | Installer build được; test thủ công ghi lệnh + kết quả; Ctrl+C qua sidecar Node thật                                                | Cài NSIS/WiX (hiện BLOCKED, tải về cần bạn cho phép)                                                                                                                                                                                                                                                 |
| C3  | Lưu `maxRounds` tuỳ chỉnh và test resume vòng ≥ 2                                                   | Test sidecar kill/restart với agent giả: tiếp tục đúng vòng; `maxRounds` được lưu                                                   | —                                                                                                                                                                                                                                                                                                    |
| C4  | Chốt 5 bước recovery                                                                                | Bạn duyệt văn bản 5 bước trong `SECURITY.md`/ASSUMPTIONS; sửa theo góp ý                                                            | **Q2: duyệt**                                                                                                                                                                                                                                                                                        |
| C5  | Soak 100 workflow với CLI thật và vá phần symlink còn hở (TOCTOU, hard link, mount point)           | Kết quả ghi `PHASE4_REPORT.md`; test hồi quy cho từng lỗ đã vá                                                                      | Chi phí CLI thật; cần bạn cho phép                                                                                                                                                                                                                                                                   |
| C6  | Hộp thoại native (R3) kiểm trong app Tauri thật; Low IL (đăng nhập/gọi model) nếu khả thi           | Ghi kết quả vào ASSUMPTIONS; mục không kiểm được ghi là ngoại lệ                                                                    | Low IL cần bạn tự đăng nhập trong thư mục cấu hình gán nhãn low                                                                                                                                                                                                                                      |
| C7  | Sửa dòng P4-8 (b) còn ghi "chặn" ở bảng ROADMAP nếu còn; đối chiếu ROADMAP với báo cáo              | ROADMAP khớp trạng thái thật                                                                                                        | —                                                                                                                                                                                                                                                                                                    |
| C8  | Đóng Phase 4: `docs/PHASE4_REPORT.md`                                                               | Đủ acceptance trong ROADMAP, lệnh + kết quả thật; mục chưa đạt ghi là ngoại lệ                                                      | Bạn xác nhận đóng phase                                                                                                                                                                                                                                                                              |
| C9  | 7C-2: cấp quyền thường trực, phạm vi hẹp (đường dẫn con trong worktree)                             | Nối `approvals.resolve` + `approval_grants` + UI (sửa IPC đủ 4 chỗ + `lib.rs` test); test hết hạn/thu hồi; xem trong app Tauri thật | Sau C1; phạm vi grant đã duyệt (2026-11-05)                                                                                                                                                                                                                                                          |
| C10 | Ngưỡng tài nguyên/concurrency lưu trong settings (song song được với C9 nếu khác file)              | Method IPC mới đủ 4 chỗ; không vượt trần `concurrency`; test                                                                        | —                                                                                                                                                                                                                                                                                                    |
| C11 | Tailwind + shadcn (đã duyệt) — thêm dependency đúng quy trình                                       | Mỗi gói: license, `pnpm audit`, pin chính xác ≥ 2 tuần, ghi `REFERENCES.md`; build/test xanh; không đổi hành vi                     | Chọn phiên bản sau khi kiểm tuổi                                                                                                                                                                                                                                                                     |
| C12 | E2E "cài đặt → project → task thật" không đụng terminal (Playwright đã duyệt)                       | Kịch bản chạy được cục bộ; ghi lệnh + kết quả                                                                                       | Sau C11                                                                                                                                                                                                                                                                                              |
| C13 | Đóng Phase 7: `docs/PHASE7_REPORT.md`                                                               | Đủ tiêu chí ROADMAP; Ctrl+Enter, preset, Auto/`agy` đã xem trong app thật                                                           | Bạn xác nhận đóng                                                                                                                                                                                                                                                                                    |

### Có thể chạy song song (khác file)

- C2 (Rust, installer) song song C3 (orchestrator, engine) và C5 (tests/soak) → dùng `/subtask` riêng worktree, giao bằng brief có tiêu chí ở trên.
- C9 và C10 chỉ song song nếu không cùng sửa bảng IPC; nếu cùng, làm tuần tự.

### Câu hỏi còn mở cho bạn

- **Q1 (C2 cũ): ĐÃ CHỌN (2026-11-07) hướng (a).** Allowlist công cụ là lớp chính; `--permission-prompt-tool` chỉ là lớp phụ và chấp nhận cổng không thấy mọi lời gọi; giới hạn đã ghi trong `docs/SECURITY.md` và `docs/ASSUMPTIONS.md`.
- **Q2 (C4):** duyệt 5 bước recovery hiện tại.
- **Q3 (C1): ĐÃ CHỌN (2026-11-07) ĐẶT MẶC ĐỊNH BẬT; ĐÃ HIỆN THỰC trong mã (ADR-007; Codex = thêm agent `codex-app-server`, không chuyển `codex`; trần RAM mặc định 8192 MB)** cho hai cổng quyền (Codex `app-server`, Claude `--permission-prompt-tool` với `askEveryTool`) và nối `jobMemLimitMb` vào cấu hình mặc định. Quyết định này thay quyết định "giữ TẮT, chờ bằng chứng" trước đó, vì đã có bằng chứng chạy CLI thật (ASSUMPTIONS d6, d9). Ràng buộc khi hiện thực: fail-closed (thiếu binary/cổng lỗi thì từ chối, không chạy không kiểm soát), có công tắc tắt rõ ràng, tài liệu phải ghi giới hạn (cổng Claude không thấy mọi lời gọi, không phải sandbox), và `--safe-mode` không nạp MCP gate nên phải xử lý đường đó.
- Lượt probe `agy` thứ 3 (P3-6) và ADR-006 (A1/A7/A8) không thuộc chặng này; hỏi lại khi tới Phase 3/sau Phase 4.

### Ngoài chặng (không làm lúc này)

Ollama + VRAM (chờ cài Ollama), Phase 5 (installer đầy đủ, `node-pty` chưa duyệt), Phase 6, 8, 9, 10, ADR-006 phần còn lại, `phase-2-kickoff-8a5732` (khuyến nghị không ghép).

---

Nội dung đã chuyển sang `docs/PHASE_PLANS.md` (kế hoạch theo phase, lane, wave và danh sách quyết định). File này chỉ giữ lại để các liên kết cũ không gãy.

Tình trạng các bước của bản cũ (soạn 2026-11-05):

- Bước 2A (policy-engine trên Windows): xong, `327eab9`.
- Bước 3 (nối resource monitor vào sidecar): xong, `9e460a2` (còn `trackedPids`, VRAM, UI, cấu hình).
- Bước 4 (test flaky): phần scheduler xong (`34a066c`, lỗi nằm ở test); `process-manager` abort chưa tái hiện.
- Bước 2B: phần 1 (probe quyền thật) xong, `5866c85`; phần nối `evaluate()` chưa làm.
- Bước 0 (đọc CI) và Bước 1 (xem Auto/`agy` trong app thật): còn mở.

## Quyết định của người dùng (2026-11-05, trả lời từng câu của `PHASE_PLANS.md`)

| Mục                             | Quyết định                                                                                       | Việc kiểm chứng còn lại                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Probe vòng quyền (P4-1 c/d)     | Duyệt cả ba: `--permission-prompt-tool` của claude, app-server/MCP của codex, cờ sandbox của CLI | Chạy trong thư mục tạm, không bỏ qua quyền; ghi `ASSUMPTIONS.md` + fixture. Chưa chạy.                      |
| Phạm vi grant 7C-2 (P7-1)       | Hẹp: đường dẫn con trong worktree                                                                | Cần P4-1 xong; test hết hạn/thu hồi.                                                                        |
| Ngưỡng tài nguyên, concurrency  | Lưu trong settings, sửa ở Settings                                                               | Thêm method IPC: đủ 4 chỗ + `cargo`; không vượt trần `concurrency`.                                         |
| Ollama và VRAM (P3-1, P3-3)     | Cài Ollama, probe thật, đo VRAM bằng `nvidia-smi`                                                | Đã kiểm: `nvidia-smi` thấy RTX 5060 Laptop, 8151 MiB; Ollama CHƯA có trong PATH (người dùng cài/tải model). |
| Probe `agy` lần 3 (P3-6)        | Cho phép                                                                                         | Task nhỏ, chỉ đọc, thư mục tạm. Chưa chạy.                                                                  |
| Dependency                      | Duyệt Tailwind + shadcn và Playwright; CHƯA duyệt `node-pty`                                     | Mỗi gói: license, audit, pin chính xác ≥ 2 tuần, `REFERENCES.md`. Chưa chọn phiên bản.                      |
| Job Object (P4-4)               | Rust đặt sidecar vào Job Object                                                                  | `cargo clippy`/`cargo test` + đo thật trên Windows; không gọi là sandbox.                                   |
| AppContainer (P4-5)             | Chỉ tài liệu hoá vào `SECURITY.md`                                                               | Ghi rõ phần chưa đạt.                                                                                       |
| Audit và ghim Actions theo SHA  | Làm trong Phase 4                                                                                | `pnpm audit`, `cargo audit`, kiểm tuổi crate.                                                               |
| Security test, soak             | Agent giả trong CI + chạy tay CLI thật                                                           | Lượt CLI thật không đưa vào CI.                                                                             |
| Xem Auto/`agy` trong app (P0-2) | Gửi thêm một task thật                                                                           | Cần claude/codex đã đăng nhập; kiểm: tắt `agy` thì task không chạy bằng `agy`.                              |
| Nhánh và worktree               | Xoá worktree đã ghép và nhánh thiếu/cũ, nhưng kiểm tra và push trước                             | Xem bên dưới.                                                                                               |

Chưa hỏi/chưa quyết: việc push mọi commit và mở PR (chỉ làm khi người dùng yêu cầu rõ).

### Kết quả dọn nhánh/worktree

- Đã kiểm trước khi xoá: 6 worktree đều sạch (không thay đổi chưa commit); 4 nhánh phiên con đã ghép đủ vào nhánh chính (0 commit riêng).
- `claude/fix-pm-abort-flaky-7e3a1f` (1 commit riêng, chỉ ghi chú): đã push lên origin (`cf97850`) trước khi xoá nhánh local. `phase-2-kickoff-8a5732` (49167f6) và `repo-current-status-acfd51` (2826397) đã có sẵn trên origin cùng SHA.
- Đã xoá 7 nhánh local; origin vẫn giữ `fix-pm-abort-flaky`, `phase-2-kickoff`, `repo-current-status`. Git đã gỡ đăng ký cả 6 worktree.
- Cập nhật sau khi người dùng cho phép xoá: đã xoá `fix-pm-abort-flaky-7e3a1f` và `repo-current-status-acfd51`. Còn 4 thư mục RỖNG (`flaky-root-cause`, `policy-win-hardening`, `probe-permissions`, `wire-resource-monitor`) bị một tiến trình khác giữ ("being used by another process"); nhiều khả năng là phiên con tương ứng còn mở với thư mục đó làm cwd (chưa xác minh). Cần đóng/lưu trữ các phiên con đó rồi xoá lại.
- Ghi chú gốc (trước khi cho phép xoá): 6 thư mục worktree vẫn còn trên đĩa (`.claude/worktrees/*`) vì `git worktree remove` báo "Filename too long" / "Permission denied". Lệnh xoá cưỡng bức bằng robocopy bị chặn nên chưa thử lại. Cần người dùng cho phép hoặc tự xoá.

## Quyết định ngày 2026-11-05, đợt 2 (kế hoạch Phase 4 phần còn lại, đã duyệt)

| Mục          | Quyết định                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| P4-1 (c)/(d) | Probe cả ba trong thư mục tạm, không bỏ qua quyền; ghi ASSUMPTIONS + fixture; DỪNG báo người dùng, không viết mã tích hợp |
| P4-2         | Dựa vào log CI Windows; không dùng fsutil                                                                                 |
| P4-4         | Job Object cấp sidecar (Rust) và cấp task (binary phụ); không gọi là sandbox                                              |
| P4-5         | Chỉ tài liệu hoá AppContainer vào `SECURITY.md`                                                                           |
| P4-6         | Nối `diagnostics.export` thành method IPC (đủ 4 chỗ + `cargo`) và nút Settings                                            |
| P4-7         | Rà capabilities, xoá quyền thừa, giữ `ALLOWED_METHODS`; không WebSocket                                                   |
| P4-8         | Tách: recovery 5 bước + UI trước; resume Peer Review sau                                                                  |
| P4-11        | Chấp nhận có lý do hai cảnh báo moderate dev-only và hai transitive; nâng khi có bản vá ≥ 2 tuần                          |
| Ghép/push    | Ghép và push khi 5 gate (và `cargo`) xanh trên bản ghép                                                                   |
