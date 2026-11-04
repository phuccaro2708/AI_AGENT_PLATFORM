# Kế hoạch tiếp theo (soạn 2026-11-05)

Căn cứ: `docs/HANDOFF.md` (trạng thái), `docs/ROADMAP.md` + ADR-005 (thứ tự phase), `docs/TODO.md` (việc còn lại), `docs/CLOUD_HANDOFF.md` (ranh giới Windows/cloud). File này chỉ nói VIỆC CẦN LÀM, VẤN ĐỀ và HƯỚNG GIẢI QUYẾT; trạng thái hiện tại vẫn nằm ở HANDOFF.

Mục tiêu: đóng phần còn lại của Phase 3 không cần người dùng duyệt, rồi mở Phase 4 (điều kiện để đóng Phase 7 theo ADR-005). Mỗi bước nêu tiêu chí kiểm chứng trước khi làm (quy tắc làm việc của `CLAUDE.md`).

Kiểm chứng chung cho mọi bước có đổi mã: `pnpm lint && pnpm exec prettier --check . && pnpm typecheck && pnpm test && pnpm build`. Bước nào đổi `src-tauri` phải chạy thêm `cargo clippy --all-targets -- -D warnings` và `cargo test`.

## Bảng tóm tắt

| Bước | Việc                                    | Ai làm / ở đâu            | Cần người dùng quyết? |
| ---- | --------------------------------------- | ------------------------- | --------------------- |
| 0    | Chốt CI các commit mới                  | Phiên chính               | Không                 |
| 1    | Xem nút Auto/`agy` trong app Tauri thật | Phiên chính, máy Windows  | Không                 |
| 2A   | Siết `policy-engine` trên Windows       | Phiên con, worktree riêng | Không                 |
| 2B   | Nối policy vào orchestrator             | CHƯA bắt đầu              | Có (quyết định 1)     |
| 3    | Nối resource monitor vào sidecar        | Phiên con, worktree riêng | Một phần (UI, ngưỡng) |
| 4    | Dọn test flaky và nhánh thừa            | Phiên con, worktree riêng | Không (nhánh: có)     |

## Bước 0: Chốt CI

- **Vấn đề:** lần đọc gần nhất, `341190d` còn Security chạy; `91317e4`, `0183a85`, `4ade477` còn Security và spike ADR-001 chạy. Chưa có kết luận cuối.
- **Hướng giải quyết:** đọc lại bằng GraphQL (`statusCheckRollup`), không dùng `gh run watch`. Ghi kết luận vào `docs/HANDOFF.md` mục CI qua `/save`.
- **Kiểm chứng:** 5/5 job xanh cho từng commit, hoặc job đỏ có nguyên nhân được ghi lại.

## Bước 1: Xem nút Auto/`agy` trong app thật

- **Vấn đề:** nút bật/tắt `agy` và lựa chọn "Auto" (`91317e4`) mới có unit test và sidecar test; chưa xem trong app Tauri. Ô tick dùng class `picker` của ô chọn nên có thể xấu giao diện.
- **Hướng giải quyết:** chạy app ngầm (không dùng chuột/phím của người dùng), chọn "Auto", bật/tắt `agy`, gửi một task. Cần CLI `claude` hoặc `codex` đã đăng nhập trên máy.
- **Kiểm chứng:**
  1. Tắt `agy`: task không chạy bằng `agy`.
  2. `agy` là agent duy nhất và đang tắt: lỗi "Không có agent phù hợp".
  3. Trạng thái nút còn nguyên sau khi khởi động lại app.
  4. Giao diện ô tick không vỡ bố cục ở cửa sổ hẹp. Nếu vỡ, sửa CSS rồi chụp lại.
- **Ghi lại:** kết quả thật vào PROGRESS; chỗ nào không chạm được thì ghi "chưa chạy".

## Bước 2A: Siết `policy-engine` trên Windows (mã thuần, không cần quyết định)

- **Vấn đề (từ HANDOFF/TODO):**
  1. `canonicalize` dùng `fs.realpath` chứ không phải `.native`, nên đường dẫn 8.3 ngắn (`RUNNER~1`) do người dùng nhập có thể lệch với dạng dài khi so `isWithin`.
  2. Junction, UNC (`\\server\share`), alternate data stream (`file.txt:stream`) chưa có test trên Windows.
- **Hướng giải quyết:**
  1. Trên Windows dùng `fs.promises.realpath.native` (hoặc `fs.realpathSync.native`) cho phần tiền tố tồn tại; giữ hành vi POSIX như cũ. Cẩn thận: `.native` đổi cách báo lỗi ở vài trường hợp, nên chạy lại toàn bộ test hiện có.
  2. Viết test Windows-only cho 8.3, junction (tạo bằng `fs.symlinkSync(..., "junction")`), UNC, ADS. Trường hợp nào chưa quyết được hành vi (ví dụ ADS: cho hay chặn) thì chọn hướng an toàn (chặn, fail-closed), ghi vào `docs/ASSUMPTIONS.md` và nói rõ cho người dùng.
  3. Không đụng orchestrator, IPC, UI.
- **Kiểm chứng:** test mới đỏ trước khi sửa (để chứng minh test bắt được lỗi), xanh sau khi sửa; toàn bộ `pnpm test` không đỏ thêm; kiểm chung ở đầu file.

## Bước 2B: Nối Policy Engine vào orchestrator (CHƯA bắt đầu)

- **Vấn đề:** engine chưa nối vào orchestrator/IPC/UI. Điểm chưa biết: `claude` và `codex` phát yêu cầu quyền ở dạng nào khi chạy thật. Quy tắc 2 của `CLAUDE.md`: không bịa capability của CLI, giả định chưa kiểm chứng phải vào `docs/ASSUMPTIONS.md` kèm probe.
- **Hướng giải quyết (sau khi người dùng quyết định 1):**
  1. Probe quan sát yêu cầu quyền thật của `claude`/`codex` (tốn lượt dùng CLI), ghi kết quả vào ASSUMPTIONS và thêm fixture.
  2. Chọn điểm gọi `evaluate()` ở phần nền tảng tự kiểm soát (gốc dự án, thư mục làm việc, lệnh spawn) và ở đường tạo approval cho `ApprovalService`.
  3. Fail-closed: lỗi trong engine thì từ chối.
  4. Nếu thêm method IPC: sửa đủ 4 chỗ (Zod trong `contracts`, `case` trong `sidecar.ts`, `ALLOWED_METHODS` + test trong `src-tauri/src/lib.rs`, stub trong `apps/desktop/src/preview-sidecar.ts`) và chạy `cargo`.
- **Kiểm chứng:** test sidecar với agent giả phát yêu cầu quyền cho ra đúng allow/ask/deny; deny không spawn gì; lỗi engine dẫn tới deny; kiểm trong app thật nếu có UI.
- **Không làm khi chưa có quyết định 1:** đoán định dạng yêu cầu quyền của CLI.

## Bước 3: Nối resource monitor vào sidecar

- **Vấn đề:** `packages/resource-monitor` và hook `SchedulerAdmission` (chỉ giảm giới hạn, không vượt `concurrency`) đã có nhưng chưa nối vào sidecar. VRAM chưa làm.
- **Hướng giải quyết:** tạo monitor trong `SidecarService` và truyền vào `Scheduler` qua `admission`; dọn timer khi `close()`. Dùng ngưỡng mặc định đã có trong `thresholds.ts`, không tự đặt số mới. Không thêm UI trong lượt này.
- **Kiểm chứng:** test dùng nguồn đo giả: tải cao thì số task chạy đồng thời giảm, tải thấp thì trở lại, không bao giờ vượt `concurrency`; `close()` không để timer treo; kiểm chung ở đầu file. Ghi rõ VRAM chưa làm.
- **Cần người dùng quyết sau đó:** ngưỡng có chỉnh được không, có hiện trạng thái tải trong UI không.

## Bước 4: Dọn test flaky và nhánh thừa

- **Vấn đề:** hai test từng chạm trần thời gian: `scheduler.test.ts` ("never runs more than `concurrency` tasks at once", hết 5 giây trên CI ubuntu ở `48ff83e`) và `process-manager` "cancels via AbortSignal" (hết 30 giây một lần trên Windows). Nghi ngờ phụ thuộc thời điểm (`setImmediate` rồi `tick`), chưa chứng minh được. Nhánh `fix-pm-abort-flaky-7e3a1f` (`cf97850`, chưa push) mới chỉ có ghi chú.
- **Hướng giải quyết:** tìm nguyên nhân gốc trước, rồi thay chờ cố định bằng chờ điều kiện rõ ràng. Không nới timeout. Nếu không tái hiện được thì nói thẳng là chưa chứng minh, không tuyên bố đã sửa.
- **Kiểm chứng:** chạy lặp mỗi test hàng trăm lần (có tải song song) trước và sau; kiểm chung.
- **Việc cần người dùng:** ghép hay bỏ nhánh `fix-pm-abort-flaky-7e3a1f`; bỏ hay giữ `repo-current-status-acfd51` (thiếu `603d6fb`).

## Quyết định cần người dùng

1. Cho phép probe yêu cầu quyền thật của `claude`/`codex` (mở khoá Bước 2B).
2. Duyệt phạm vi grant 7C-2 nếu muốn làm cùng Phase 4.
3. Ngưỡng tài nguyên và có hiển thị trong UI không (sau Bước 3).
4. Số phận hai nhánh `fix-pm-abort-flaky-7e3a1f`, `repo-current-status-acfd51`.

Vẫn chờ duyệt riêng, không thuộc kế hoạch này: dependency Tailwind/shadcn và Playwright, lượt probe `agy` thứ 3, bỏ `phase-2-kickoff-8a5732`.

## Thứ tự và phụ thuộc

0 → 1 song song với 2A, 3, 4 (khác file nên không đụng nhau; 3 sửa `sidecar.ts`/`scheduler.ts`, 4 chỉ sửa test) → 2B khi có quyết định 1. Mỗi phiên con làm trong worktree riêng, commit trên nhánh riêng, không push; phiên chính kiểm lại rồi mới ghép.
