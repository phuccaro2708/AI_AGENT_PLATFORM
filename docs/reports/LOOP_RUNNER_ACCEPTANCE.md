# Báo cáo nghiệm thu Loop Runner (Task 13)

Ngày chạy: 2026-11-09. Công cụ: repo `<repo B>` (`loop-runner`), bản dựng `dist/cli.js` ở HEAD `769c7a9` (trước commit mẫu). Agent: **agent thật** (Claude cho orchestrator và implementer, Codex cho reviewer), người dùng đã duyệt gọi CLI thật với ngân sách nhỏ. **Không dùng agent giả/stub**: schema cấu hình không có khoá cấu hình lệnh agent, nên không thể thay bằng stub; mọi lần chạy dưới đây gọi Claude/Codex thật.

Chú thích: mọi đường dẫn máy cá nhân được thay bằng `<repo B>`, `<scratch>`, `<worktree>`. Kết quả lấy từ output thật của lệnh; phần rút gọn được đánh dấu `[...]`.

## Tóm tắt

| Bước | Nội dung                                                         | Kết quả                                                                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Chạy thật một task trên bản sao dùng-một-lần của Agent Workspace | **PARTIAL**: gate xanh 5/5, commit và dòng PROGRESS có; nhưng runner kết thúc `blocked` (exit 2) vì guard báo (nghi báo sai do git tự bảo trì). Chạy lại 2026-11-10 với setup cài thật: **BLOCKED** (setup PASS ~23 s, gate `test` chập chờn do môi trường, exit 2), xem mục cuối |
| 2a   | Gate lỗi, output khác nhau mỗi lần                               | **PASS**: đúng 3 lần sửa, BLOCKED, exit 2                                                                                                                                                                                                                                         |
| 2b   | Gate lỗi, output giống hệt                                       | **PASS**: dừng sau lần 2, exit 4                                                                                                                                                                                                                                                  |
| 3    | Cấu hình thiếu/sai                                               | **PASS** về từ chối và exit 1; **FAIL** một chi tiết: lỗi "unknown key" không nêu tên khoá (bị redactor che)                                                                                                                                                                      |
| 4    | Dự án mẫu thứ hai chỉ thêm `loop.config.json`                    | **PASS**: task xong, gate xanh, phase đóng, exit 0                                                                                                                                                                                                                                |

Phát hiện chính (chi tiết ở các bước và mục cuối): (a) `loop.config.json` của Agent Workspace dùng `"command": "pnpm"` không chạy được trên Windows vì công cụ spawn không qua shell; (b) guard `shared git config/hooks/info changed` có thể báo sai; (c) redactor che tên khoá lạ trong lỗi cấu hình.

## Bước 1: chạy thật trên Agent Workspace

Task lớn đầu tiên trong `docs/TODO.md` không được chạy. Thay vào đó: bản sao `<scratch>/aw-accept` (clone cục bộ của nhánh làm việc, nhánh dùng-một-lần `accept/throwaway`), `docs/TODO.md` có thêm đúng một task nhỏ chỉ sửa tài liệu ("thêm đúng một dòng ... vào cuối `docs/NEXT_PLAN.md`"), cùng `loop.config.json` nhưng `maxAttemptsPerTask: 2`, ngân sách Claude 5 lần gọi / Codex 3 lần gọi, `timeLimitMs` 25 và 15 phút. `node_modules` được nối bằng junction (cài offline thất bại: `ERR_PNPM_NO_OFFLINE_TARBALL`, thiếu gói `@tauri-apps/api` trong store); với worktree của lần chạy, một script ngoài hai repo nối junction `node_modules` ngay khi worktree xuất hiện. Hệ quả: các gói workspace trong lần chạy trỏ về mã của checkout nguồn, không phải mã trong worktree; chấp nhận được cho task chỉ sửa tài liệu, nhưng đây là điều kiện nghiệm thu, không phải môi trường sạch.

Có 4 lần chạy thật:

1. `node <repo B>/dist/cli.js run --project <scratch>/aw-accept` -> **FAIL (exit 4)**. Gate `lint` BLOCKED trước khi chạy được gì:

   ```
   gate lint BLOCKED (exit null):
   Command not found: "pnpm" (ENOENT). Check that it is installed and on PATH. [...]
   stop: repeated-failure: same failure twice in a row (lint:e24c0ce7d9d4) [...]
   ```

   Nguyên nhân thật: trên Windows `pnpm` là shim `.cmd`, công cụ spawn với `shell: false` nên không tìm thấy. Nghĩa là `loop.config.json` hiện có của Agent Workspace **không chạy được trên Windows như đã commit**. Cách vòng trong bản sao dùng-một-lần: `"command": "node"`, `args: ["<đường dẫn pnpm.cjs>", "lint"]` (đường dẫn máy cá nhân, không commit).

2. Chạy lại với cách vòng trên nhưng tôi gõ sai đường dẫn `pnpm.cjs` (lỗi của tôi: script sửa cấu hình thất bại nhưng chuỗi lệnh vẫn chạy tiếp) -> lặp lại đúng lỗi ENOENT, exit 4.
3. Chạy với `pnpm.cjs` đúng -> **FAIL (exit 4)**: `lint` PASS, `format` FAIL vì chính file `loop.config.json` tôi ghi lại không đúng định dạng Prettier (`Code style issues found in the above file`). Lỗi của cấu hình tạm do tôi tạo ra, không phải của công cụ; chạy `prettier --write` rồi chạy lại.
4. Lần chạy cuối (`run-20261109-213600-09bb`, 1 lần thử) -> `status: blocked`, **exit 2**:
   - Dòng PROGRESS ghi trên nhánh chạy: `... done after 1 attempt(s); gates: lint PASS, format PASS, typecheck PASS, test PASS, build PASS`.
   - Reviewer (Codex) chạy và không báo SECURITY_FINDING CONFIRMED.
   - Commit trên nhánh chạy: `9379f58` `chore(loop): complete task phase-3:...`, gồm `docs/NEXT_PLAN.md` (+2 dòng, đúng nội dung task), `docs/PROGRESS.md` (+1), `docs/TODO.md` (task được tick).
   - Sau commit, guard hậu-commit dừng:

     ```
     stop: blocked: needs_reconciliation: diff guard violations after the runner commit 9379f58d4220 [...]: shared git config/hooks/info changed. The commit exists on loop/run-20261109-213600-09bb; inspect it, nothing is retried
     ```

   - Chẩn đoán (giả thuyết, chưa tái hiện riêng): trong `.git` của bản sao, `info/refs` và `objects/pack/multi-pack-index` có mtime trùng thời điểm kết thúc lần chạy, còn `config` không đổi trong lần chạy; đây là dấu vết của git tự bảo trì (gc/maintenance) sau commit, và `computeConfigHash` băm cả thư mục `info/`. Nếu đúng, đây là báo sai: runner dừng một lần chạy thành công và coi là `needs_reconciliation`.
   - Ngoài ra phase `phase-3` không có tiêu chí nào có `command` (chỉ văn bản) nên theo thiết kế là NOT_RUN và phase không đóng, kể cả khi guard không báo; phù hợp quy ước "không PASS nếu không có lệnh".

Kết luận bước 1: **PARTIAL**. Task thật đã được agent thật làm xong trong worktree riêng, 5 gate PASS bằng exit code thật, commit và dòng PROGRESS có; vòng lặp **không** kết thúc sạch (exit 2), và cấu hình Agent Workspace cần sửa cho Windows trước khi dùng thật.

## Bước 2: task cố tình lỗi (agent thật, `tests/acceptance/sample-fail*`)

Dự án mẫu trong `<repo B>/tests/acceptance/`; chạy bằng `node tests/acceptance/prepare.mjs <mẫu> <thư mục trống>` rồi `node dist/cli.js run --project <thư mục>`. Gate là một lệnh `node -e` nằm ngay trong `loop.config.json` (agent không được sửa file này) luôn thoát mã 1. `maxAttemptsPerTask: 3`, `stopOnRepeatedFailure: true`, ngân sách Claude 6 lần.

**2a `sample-fail` (output khác nhau mỗi lần): PASS.**

```
attempt 1 failed (gate, always-fail-varying:a88094203560): [...]
attempt 2 failed (gate, always-fail-varying:5427bfeece55): [...]
attempt 3 failed (gate, always-fail-varying:4181bcba3deb): [...]
stop: blocked: task phase-1:make-the-always-failing-gate-pass-[...] failed 3 attempt(s) [...]
status: blocked
phase phase-1: open
task phase-1:[...]: BLOCKED (3 attempt(s))
exit=2
```

Ba dấu vân tay khác nhau, đúng 3 lần, vòng lặp dừng, phase mở, không sang task/phase sau.

**2b `sample-fail-same` (output giống hệt): PASS.**

```
attempt 1 failed (gate, always-fail-identical:7125dfaef8be): [...]
attempt 2 failed (gate, always-fail-identical:7125dfaef8be): [...]
stop: repeated-failure: same failure twice in a row (always-fail-identical:7125dfaef8be) [...]
status: repeated-failure
task phase-1:[...]: BLOCKED (2 attempt(s))
exit=4
```

Dừng sớm sau lần 2 (không đến lần 3).

## Bước 3: cấu hình thiếu/sai (không gọi agent)

Lệnh `node dist/cli.js check --project <dir>` (và `run` cho hai trường hợp) trên `tests/acceptance/refusals/*`:

| Trường hợp                                                           | Thông báo (rút gọn)                                                                 | Exit | Kết quả                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------- |
| Thư mục không có `loop.config.json`                                  | `error: cannot read config file <dir>/loop.config.json: ENOENT [...]`               | 1    | PASS                                                                  |
| JSON hỏng                                                            | `error: invalid JSON in <...>/loop.config.json: Unexpected end of JSON input`       | 1    | PASS                                                                  |
| Khoá lạ `gatez` ở gốc                                                | `error: invalid config <...>: (root): Unrecognized key: [REDACTED]`                 | 1    | **FAIL một phần**: từ chối đúng, không đoán, nhưng không nêu tên khoá |
| Đường dẫn tuyệt đối ngoài dự án (`taskFile` trỏ vào thư mục Windows) | `error: taskFile: path "C:\Windows\win.ini" resolves outside the project directory` | 1    | PASS                                                                  |
| Đường dẫn thoát dự án (`../outside/TODO.md`)                         | `error: taskFile: path "../outside/TODO.md" resolves outside the project directory` | 1    | PASS                                                                  |
| `run` với config thiếu                                               | cùng thông báo ENOENT                                                               | 1    | PASS                                                                  |
| `run` với đường dẫn thoát dự án                                      | cùng thông báo                                                                      | 1    | PASS                                                                  |

Lỗi "unknown key": `loadConfig` tạo thông báo `Unrecognized key: "gatez"` đúng, nhưng `redact()` (áp lên mọi dòng in ra) che `"gatez"` thành `[REDACTED]` vì dạng `key: "giá trị"` giống một cặp bí mật. Công cụ không đoán và vẫn từ chối (exit 1), nhưng README tuyên bố lỗi "nêu tên khoá" thì chưa đúng ở đường in ra thật. Chưa sửa (ngoài phạm vi Task 13).

Chưa kiểm ở đây: đường dẫn tuyệt đối nằm trong dự án (README nói được chấp nhận); đã có unit test ở repo B nhưng không chạy lại riêng.

## Bước 4: dự án mẫu thứ hai `sample-ok`

Dự án chỉ có `package.json`, `TODO.md`, `PROGRESS.md` và `loop.config.json` (không sửa công cụ). Task: tạo `hello.mjs` in `hello` và `hello.test.mjs` (node:test). Gate: `node --test`. Tiêu chí phase: `node hello.mjs`. **PASS**, exit 0:

```
task phase-1:create-a-file-hello-mjs-[...]: committed 2221af2b6ed2
report template unreadable; using the built-in template
phase phase-1: closed
status: completed
reason: every configured phase closed
task phase-1:[...]: done (1 attempt(s))
exit=0
```

Nhánh chạy: commit task (`PROGRESS.md`, `TODO.md`, `hello.mjs`, `hello.test.mjs`) và commit báo cáo phase `PHASEphase-1_REPORT.md` (tiêu chí `node hello.mjs` PASS). Dòng PROGRESS: `... done after 1 attempt(s); gates: test PASS`. Dòng "report template unreadable" là bình thường: mẫu không có file mẫu báo cáo, công cụ dùng bản dựng sẵn.

## Điều chưa kiểm chứng / giới hạn

- Chưa chạy task thật nào của Agent Workspace (task đầu tiên quá lớn); chỉ một task tài liệu dùng-một-lần trên bản sao.
- Gate Agent Workspace chạy trong điều kiện junction `node_modules` (mã gói trỏ về checkout nguồn); chưa chạy trên bản cài sạch (cài offline không khả thi, không dùng mạng).
- Chưa có lần chạy trọn vẹn trên Agent Workspace kết thúc exit 0; lần cuối bị guard dừng. Giả thuyết git tự bảo trì chưa được tái hiện độc lập.
- Cấu hình `pnpm` của Agent Workspace chưa được sửa; chưa quyết định cách sửa (công cụ hỗ trợ shim `.cmd`/`pnpm.cjs`, hoặc config dùng `node` + đường dẫn tương đối).
- Mẫu `sample-fail*` dùng agent thật; việc agent có thử sửa file hay không không được kiểm riêng ngoài việc gate vẫn lỗi.
- Số lần gọi thật (ước tính theo log, không đo token): khoảng 11 lần Claude cho bước 1 (4 lần chạy), 4 + 3 + 2 lần Claude cho 2a/2b/4, và 2 lần Codex (bước 1 lần cuối, bước 4).
- Bản sao, worktree chạy và nhánh `loop/*` của lần chạy đã xoá; không nhánh nào bị ghép hay push.

## Chạy lại bước 1 sau I-8 (2026-11-10)

Mục đích: chạy lại bước 1 với CLI Claude/Codex thật và bước `setup` thật (`pnpm install --frozen-lockfile`, người dùng đã duyệt, mạng chỉ cho bước cài), **không** nối junction `node_modules`. Công cụ: `<repo B>` HEAD `fd3ff78`, `pnpm build` xong trước khi chạy. Bản sao dùng-một-lần `<scratch>/aw-accept2` (clone của Agent Workspace tại HEAD `1038729`, đã gỡ remote, nhánh `accept2/throwaway`), một commit thêm: task docs-only trong phần Phase 3 của `docs/TODO.md` ("thêm đúng một dòng ghi chú vào cuối `docs/NEXT_PLAN.md`") và trong `loop.config.json`: `maxAttemptsPerTask: 2`, ngân sách Claude 5 lần gọi / 25 phút, Codex 3 lần gọi / 15 phút. Cấu hình giữ `"command": "pnpm"` đúng như đã commit (không cần cách vòng `pnpm.cjs` như lần trước).

Lệnh:

```
node <repo B>/dist/cli.js check --project <scratch>/aw-accept2      # liệt kê setup (1), gates (5), phases (8)
node <repo B>/dist/cli.js run   --project <scratch>/aw-accept2
```

Kết quả: **BLOCKED, exit 2** (`status: blocked`, tổng 1061 s, 17:33:24 đến 17:51:05).

| Mục                                                                 | Kết quả                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup: install` (`pnpm install --frozen-lockfile`, trong worktree) | **PASS**: `setup: done; 35366 ignored path(s) taken as the diff guard baseline`. Thời gian ~23 s (worktree tạo 17:33:25, `node_modules/.modules.yaml` ghi 17:33:48; store pnpm đã nóng). Kiểm tra sau setup qua: runner đi tiếp sang gọi agent, không có `needs_reconciliation`; `git status --short` ở worktree chỉ có file agent sửa, không file tracked bị đổi hay untracked không-ignore do cài đặt. |
| Gate `lint`, `format`, `typecheck` (trong runner)                   | **PASS** (suy ra: runner chạy gate theo thứ tự và chỉ báo `test` FAIL; log không in dòng PASS từng gate khi gate sau lỗi)                                                                                                                                                                                                                                                                                |
| Gate `test` (trong runner)                                          | **FAIL cả 2 lần thử**, exit 1: lần 1 `6 failed` file / `8 failed` test (tests 296 s), lần 2 `3 failed` file / `5 failed` test (224 s). Tập test lỗi khác nhau giữa hai lần                                                                                                                                                                                                                               |
| Gate `build` (trong runner)                                         | **NOT_RUN** (vòng lặp dừng ở `test`)                                                                                                                                                                                                                                                                                                                                                                     |
| Codex review                                                        | **NOT_RUN**: ngân sách Codex `calls 0/3`; reviewer chỉ chạy khi gate qua                                                                                                                                                                                                                                                                                                                                 |
| Commit trên nhánh chạy / dòng PROGRESS                              | **Không có**: nhánh `loop/run-20261110-233325-375e` vẫn ở `e846db8`; worktree chỉ có sửa chưa commit ở `docs/NEXT_PLAN.md` (+2 dòng, đúng nội dung task). Không dòng PROGRESS                                                                                                                                                                                                                            |
| Ngân sách đã dùng                                                   | Claude `calls 3/5`, 175 s; Codex `0/3`                                                                                                                                                                                                                                                                                                                                                                   |
| Trạng thái cuối                                                     | `task ...: BLOCKED (2 attempt(s))`, `stop: blocked: ... failed 2 attempt(s); last failure (gate)`, exit 2. Không phải 4 vì dấu vân tay lỗi khác nhau (`test:1:35731ac92432` rồi `test:1:9c2a8ad29d75`)                                                                                                                                                                                                   |

Lỗi gate `test` (trích từ output thật, đường dẫn đã thay):

```
FAIL services/orchestrator/src/sidecar-resume.test.ts > ... > without a stored maxRounds the default of 2 ends the workflow after round 2
Error: EPERM, Permission denied: \?\~\AppData\Local\Temp\as-resume-XXXXXX      (rmSync trong afterEach)
× RSS and CPU time of a real child match what the child reports about itself 2899ms
× returns a well-formed response (never throws, never asks to shut down), whatever the parameters 60053ms   (sidecar-ipc-security.test.ts)
Test Files  3 failed | 104 passed | 4 skipped (111)      Tests  5 failed | 1036 passed | 6 expected fail | 68 skipped (1115)
```

Chẩn đoán (không sửa công cụ, không sửa mã Agent Workspace):

- Đây là lỗi môi trường/độ chập chờn của bộ test, không phải do runner hay do agent. Agent chỉ sửa `docs/NEXT_PLAN.md`; các test lỗi không liên quan tới file đó.
- Đối chứng ngoài runner, cùng máy: chạy `pnpm exec vitest run services/orchestrator/src/sidecar-resume.test.ts` **trong chính checkout Agent Workspace** (không qua runner, không phải worktree mới) cũng FAIL 1/12 vì `Test timed out in 5000ms` ở test "a stored maxRounds of 3 survives the restart". Chạy cùng nhóm test (resume, ipc-security, process-manager) trong worktree của lần chạy cũng chỉ còn 1 test timeout. Tập test lỗi thay đổi theo từng lần chạy: dấu hiệu máy chậm/bị tải (timeout 5 s bị vượt, `EPERM` khi xoá thư mục tạm, có thể do quét thời gian thực của Windows), không phải lỗi tất định.
- Kiểm tay ngoài runner trong worktree của lần chạy: `pnpm lint` exit 0 (23 s), `pnpm format` exit 0 (26 s), `pnpm typecheck` exit 0 (106 s), `pnpm build` exit 0 (108 s). Số liệu tay, không phải kết quả của runner.
- Chưa đo được overhead của guard (diff guard liệt kê cả cây ignored 35366 mục): log không in thời gian từng lần gọi guard. Tổng thời gian ngoài gate và agent không tách được từ output hiện có.

Kết luận lần chạy lại: bước 1 **BLOCKED (không PASS)** vì môi trường, nhưng chứng minh được ba điều mới: (1) `setup` cài thật trong worktree sạch chạy được (~23 s) và guard sau setup không báo sai, runner đi tiếp; (2) cấu hình `pnpm` dạng `"command": "pnpm"` nay chạy được trên Windows (hết ENOENT); (3) không thấy lại báo sai `shared git config/hooks/info changed`, nhưng vì không có commit nên guard hậu-commit chưa được thực thi lần nào, chưa thể coi đã khắc phục. Chưa kiểm chứng: lần chạy kết thúc exit 0, gate `build`, Codex review, commit nhánh chạy và dòng PROGRESS trên bản cài sạch. Cần chạy lại khi suite test ổn định trên máy (hoặc nâng timeout test ở nơi có thẩm quyền, ngoài phạm vi công cụ này).

Dọn dẹp: bản sao, worktree chạy và nhánh `loop/*` của lần chạy đã xoá; không nhánh nào bị ghép hay push. Không có junction trong lần này.
