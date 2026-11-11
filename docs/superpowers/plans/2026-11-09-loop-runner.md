# Loop Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một công cụ CLI dùng chung cho mọi dự án, chạy vòng lặp Orchestrator → Implementation → Gate → Merge Gate bằng `claude` và `codex`, cấu hình bằng một file ở gốc mỗi dự án.

**Architecture:** Repo độc lập `D:\Program\loop-runner` (Node + TypeScript). Mỗi lần chạy tạo một worktree của dự án đích, lặp qua task theo state machine thuần (không phụ thuộc CLI thật, test được bằng agent giả), chạy gate bằng lệnh thật và quyết định PASS/FAIL từ mã thoát. Các adapter `claude`/`codex` chỉ là lớp mỏng gọi CLI bằng argument array, `shell: false`.

**Tech Stack:** Node.js LTS, TypeScript, Zod (validate cấu hình), Vitest. Mọi dependency pin version chính xác và tuổi ≥ 2 tuần, kiểm tra bằng `pnpm audit`.

**Spec:** `docs/superpowers/specs/2026-11-09-autonomous-loop-runner-design.md` (trong repo Agent Workspace)

## Global Constraints

- Windows-first, chạy từ PowerShell; Node.js LTS + TypeScript.
- Spawn process bằng argument array, `shell: false`; không nối prompt vào chuỗi shell.
- Tối đa **3** lần tự sửa mỗi task, quá thì `BLOCKED`; phase còn task BLOCKED thì dừng hẳn, không sang phase sau.
- Ngân sách tính cho cả lần chạy, áp cho Claude và Codex riêng; không đo được token thì dùng số lượt gọi hoặc thời gian và báo rõ.
- PASS/FAIL/NOT_RUN chỉ lấy từ mã thoát và output lệnh thật, không do LLM phán xét. Tiêu chí phase không có lệnh thì phase đó không tự đóng (NOT_RUN).
- Không `git push`, không tạo PR, không thêm dependency vào dự án đích, không ghi ngoài thư mục dự án đích.
- Không tự merge: kết quả để lại là nhánh, log và báo cáo phase.
- Không bịa capability của CLI: giả định chưa kiểm chứng ghi vào `docs/ASSUMPTIONS.md` của dự án đích sau khi probe (Task 2).
- Không ghi secrets, đường dẫn máy cá nhân, token vào log hay báo cáo.
- Task có side effect không xác minh được → `needs_reconciliation`, không tự retry.

## Review Focus

- Gate chạy `pnpm`/`codex` trên Windows với `shell: false`: file `.cmd` không spawn trực tiếp được; kỳ vọng là lỗi rõ ràng hoặc cách resolve đúng, không treo hay im lặng thành PASS.
- Tiến trình agent bị treo hoặc vượt thời gian: kỳ vọng là bị kill cả cây tiến trình, tính vào ngân sách và task chuyển lỗi, không chạy mãi.
- Cấu hình có đường dẫn thoát khỏi dự án (`..`, đường dẫn tuyệt đối khác ổ): kỳ vọng là từ chối khi nạp.
- Output gate rất dài hoặc chứa chuỗi giống token: kỳ vọng là cắt gọn và che trước khi vào log/báo cáo.
- Dự án đích có việc chưa commit hoặc đang ở detached HEAD: kỳ vọng là worktree vẫn cắt từ đầu nhánh hiện tại, không động việc của người dùng, hoặc từ chối rõ ràng khi không xác định được nhánh.

---

### Task 1: Xin phép và dựng khung repo công cụ

**Files:**

- Create (trong `D:\Program\loop-runner`): `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `tests/smoke.test.ts`, `.gitignore`, `README.md`

**Interfaces:**

- Produces: lệnh `pnpm test`, `pnpm typecheck`, `pnpm build` chạy được trong repo công cụ; thư mục `src/` và `tests/` cho các task sau.

- [ ] **Step 1: DỪNG và xin phép người dùng** tạo thư mục `D:\Program\loop-runner` và `git init` ở đó (nguyên tắc 8 cấm sửa ngoài repo; spec mục 12). Không tiếp tục khi chưa có "yes" rõ ràng. Hỏi luôn việc cài lệnh toàn cục (`pnpm link --global` hoặc tương đương) ở Task 11.
- [ ] **Step 2: Viết test khói** `tests/smoke.test.ts`: `expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)` với `VERSION` xuất từ `src/index.ts`. Chạy `pnpm test`, kỳ vọng FAIL (chưa có `VERSION`).
- [ ] **Step 3: Tạo khung** (TypeScript strict, ESM, Vitest) và `export const VERSION = "0.1.0"`. Dependency pin chính xác, kiểm tra tuổi ≥ 2 tuần và `pnpm audit`.
- [ ] **Step 4: Chạy** `pnpm typecheck && pnpm test`, kỳ vọng PASS.
- [ ] **Step 5: Commit** `chore: scaffold loop-runner` (trong repo công cụ).

### Task 2: Probe CLI và ghi giả định

**Files:**

- Create: `scripts/probe.ts` (trong repo công cụ)
- Modify: `docs/ASSUMPTIONS.md` của Agent Workspace (mục "Loop Runner probes")

**Interfaces:**

- Produces: kết luận đã kiểm chứng cho bốn giả định ở spec mục 8, và các cờ CLI cụ thể mà Task 8 dùng. Mỗi mục ghi `VERIFIED` hoặc `UNVERIFIED` kèm lệnh và output thật.

- [ ] **Step 1: Viết `scripts/probe.ts`** chạy lần lượt, bằng argument array: `claude --version`, `claude -p` với prompt tối thiểu ở thư mục tạm, `codex --version`, `codex exec` ở `read-only` và `workspace-write` trên thư mục tạm, và đo xem output có chứa số token/chi phí hay không. In kết quả dạng bảng PASS/FAIL/UNVERIFIED.
- [ ] **Step 2: Chạy** `pnpm tsx scripts/probe.ts`; chỉ dùng thư mục tạm, không gửi mã hay dữ liệu dự án cho CLI.
- [ ] **Step 3: Ghi kết quả thật** vào `docs/ASSUMPTIONS.md`: lệnh, mã thoát, đoạn output chứng minh, và quyết định ngân sách (đo token được, hoặc dùng số lượt/thời gian theo spec mục 7).
- [ ] **Step 4: Nếu một giả định sai** (ví dụ không có chế độ ghi không tương tác), dừng và báo người dùng trước khi sang Task 3.
- [ ] **Step 5: Commit** ở cả hai repo.

### Task 3: Nạp và kiểm tra cấu hình

**Files:**

- Create: `src/config.ts`, `tests/config.test.ts`

**Interfaces:**

- Produces: `loadConfig(projectDir: string): LoopConfig` (ném `ConfigError` có thông điệp cụ thể). `LoopConfig` gồm: `gates: {name; command; args[]; timeoutMs}[]`, `taskFile: string`, `phases: {id; heading; criteria: {text; command?; args?[]}[]}[]` (theo thứ tự chạy), `progressFile`, `reportTemplate`, `forbidden: {dependencyFiles: string[]}`, `limits: {maxAttemptsPerTask: number (mặc định 3); stopOnRepeatedFailure: boolean (mặc định true)}`, `budget: {claude: Budget; codex: Budget}`, `roles` (vai nào bật, model nào).

- [ ] **Step 1: Viết test** `loads a valid config`, `rejects missing file with ConfigError naming the path`, `rejects path escaping project (..)`, `rejects criterion without command as notRunnable but still loads` (tiêu chí không lệnh được giữ lại, đánh dấu để Task 7 coi là NOT_RUN), `rejects maxAttemptsPerTask < 1`.
- [ ] **Step 2: Chạy** `pnpm vitest run tests/config.test.ts`, kỳ vọng FAIL.
- [ ] **Step 3: Implement** `loadConfig` bằng Zod; chuẩn hoá và kiểm tra mọi đường dẫn nằm trong `projectDir` (kể cả sau khi resolve).
- [ ] **Step 4: Chạy lại**, kỳ vọng PASS.
- [ ] **Step 5: Commit** `feat: load and validate project config`.

### Task 4: Chạy process an toàn và che dữ liệu nhạy cảm

**Files:**

- Create: `src/exec.ts`, `src/redact.ts`, `tests/exec.test.ts`, `tests/redact.test.ts`

**Interfaces:**

- Produces: `run(command: string, args: string[], opts: {cwd: string; timeoutMs: number; env?: Record<string,string>}): Promise<RunResult>` với `RunResult = {code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number}`; `redact(text: string): string`; `tail(text: string, maxLines: number): string`.

- [ ] **Step 1: Viết test** `run uses argument array without a shell` (đối số chứa `&` và khoảng trắng được truyền nguyên), `run kills the whole process tree on timeout and returns timedOut: true`, `run reports a Windows .cmd shim clearly or runs it correctly` (không được trả PASS im lặng), `redact masks strings shaped like tokens`, `tail keeps the last N lines`.
- [ ] **Step 2: Chạy**, kỳ vọng FAIL.
- [ ] **Step 3: Implement** bằng `child_process.spawn` với `shell: false`; kill cả cây khi hết giờ (tham chiếu cách `packages/process-manager` của Agent Workspace làm tree-kill, tự viết lại độc lập); cách xử lý `.cmd` do builder chọn nhưng không dùng chuỗi shell.
- [ ] **Step 4: Chạy lại**, kỳ vọng PASS.
- [ ] **Step 5: Commit** `feat: safe process runner and redaction`.

### Task 5: Gate và nhận diện lỗi lặp

**Files:**

- Create: `src/gates.ts`, `tests/gates.test.ts`

**Interfaces:**

- Consumes: `LoopConfig['gates']`, `run`, `tail`, `redact`.
- Produces: `runGates(gates, cwd): Promise<GateReport>` với `GateReport = {passed: boolean; results: {name; status: 'PASS'|'FAIL'|'BLOCKED'; code; outputTail}[]}`; `fingerprint(report: GateReport): string | null` (tên gate đầu tiên FAIL + vài dòng lỗi đầu đã chuẩn hoá: bỏ timestamp, đường dẫn tuyệt đối, số dòng).

- [ ] **Step 1: Viết test** `all gates pass → passed true`, `first failing gate stops the rest and is FAIL`, `gate that cannot start is BLOCKED not PASS`, `same failure with different timestamps yields the same fingerprint`, `different failing gates yield different fingerprints`.
- [ ] **Step 2: Chạy**, kỳ vọng FAIL.
- [ ] **Step 3: Implement** theo chữ ký trên.
- [ ] **Step 4: Chạy lại**, kỳ vọng PASS.
- [ ] **Step 5: Commit** `feat: gates and failure fingerprint`.

### Task 6: Nguồn task và tiêu chí phase

**Files:**

- Create: `src/tasks.ts`, `tests/tasks.test.ts`

**Interfaces:**

- Consumes: `LoopConfig['taskFile' | 'phases']`.
- Produces: `nextTask(projectDir, config): Task | null` với `Task = {id: string; phaseId: string; title: string}` (task là dòng `- [ ]` đầu tiên dưới tiêu đề phase đang chạy, theo thứ tự `phases`); `evaluatePhase(phase, cwd): Promise<{closable: boolean; criteria: {text; status: 'PASS'|'FAIL'|'NOT_RUN'}[]}>` (tiêu chí không có lệnh = NOT_RUN, không bao giờ PASS).

- [ ] **Step 1: Viết test** `picks the first unchecked task of the current phase`, `skips checked tasks`, `returns null when the phase has no unchecked tasks`, `phase with a criterion lacking a command is not closable (NOT_RUN)`, `phase closable only when every criterion command exits 0`.
- [ ] **Step 2: Chạy**, kỳ vọng FAIL.
- [ ] **Step 3: Implement.** Quy ước đọc task (checkbox markdown dưới tiêu đề cấu hình) là lựa chọn của người dựng, ghi vào README.
- [ ] **Step 4: Chạy lại**, kỳ vọng PASS.
- [ ] **Step 5: Commit** `feat: task source and phase criteria`.

### Task 7: Ngân sách

**Files:**

- Create: `src/budget.ts`, `tests/budget.test.ts`

**Interfaces:**

- Produces: `type Budget = {maxCalls?: number; maxMs?: number; maxTokens?: number}`; `class BudgetTracker { constructor(budget: Budget, mode: 'tokens'|'calls-time'); record(call: {durationMs: number; tokens?: number}): void; exceeded(): boolean; describe(): string }`. `describe()` nói rõ khi đang dùng chế độ thay thế (calls-time).

- [ ] **Step 1: Viết test** `exceeded after maxCalls`, `exceeded after maxMs`, `tokens ignored when mode is calls-time`, `describe states the fallback mode`.
- [ ] **Step 2: Chạy**, kỳ vọng FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Chạy lại**, kỳ vọng PASS.
- [ ] **Step 5: Commit** `feat: per-agent budget tracking`.

### Task 8: Worktree và bảo vệ diff

**Files:**

- Create: `src/worktree.ts`, `src/guard.ts`, `tests/worktree.test.ts`, `tests/guard.test.ts`

**Interfaces:**

- Consumes: `run`.
- Produces: `createRunWorktree(projectDir: string, runId: string): Promise<{path: string; branch: string}>` (cắt từ đầu nhánh hiện tại; từ chối khi detached HEAD); `checkDiff(worktree: string, baseRef: string, forbidden: {dependencyFiles: string[]}): Promise<{ok: boolean; violations: string[]}>` (vi phạm khi đổi file dependency, ghi ngoài worktree, hoặc có dấu vết `git push`/tạo PR trong lệnh đã chạy nếu agent adapter báo lại).

- [ ] **Step 1: Viết test trên repo git tạm** `worktree is cut from the current branch tip and leaves the main checkout untouched`, `uncommitted changes in the main checkout are untouched`, `detached HEAD is refused with a clear error`, `checkDiff flags a changed package.json`, `checkDiff passes a source-only change`.
- [ ] **Step 2: Chạy**, kỳ vọng FAIL.
- [ ] **Step 3: Implement** bằng `git worktree add`.
- [ ] **Step 4: Chạy lại**, kỳ vọng PASS.
- [ ] **Step 5: Commit** `feat: run worktree and diff guard`.

### Task 9: Adapter Claude/Codex và prompt vai

**Files:**

- Create: `src/agents.ts`, `prompts/orchestrator.md`, `prompts/implementer.md`, `prompts/reviewer.md`, `tests/agents.test.ts`

**Interfaces:**

- Consumes: `run`, `BudgetTracker`, kết quả probe của Task 2 (cờ CLI đã kiểm chứng).
- Produces: `interface Agent { invoke(role: 'orchestrator'|'implementer'|'reviewer', prompt: string, cwd: string): Promise<AgentResult> }` với `AgentResult = {ok: boolean; summary: string; durationMs: number; tokens?: number; securityFinding?: 'CONFIRMED'|'PLAUSIBLE'}`; `createClaudeAgent(opts)`, `createCodexAgent(opts)`; `createFakeAgent(script: AgentResult[])` cho test. Reviewer luôn chạy đọc-chỉ.

- [ ] **Step 1: Viết test** `claude adapter builds an argument array (no shell string)`, `codex reviewer is spawned read-only`, `a timed out call is ok:false and recorded in the budget`, `fake agent replays its script`.
- [ ] **Step 2: Chạy**, kỳ vọng FAIL.
- [ ] **Step 3: Implement** dùng đúng cờ đã probe; prompt vai là file Markdown cố định, tham số hoá bằng task/cấu hình, nhắc rõ các điều cấm của spec mục 9.
- [ ] **Step 4: Chạy lại**, kỳ vọng PASS.
- [ ] **Step 5: Commit** `feat: claude and codex adapters`.

### Task 10: State machine vòng lặp

**Files:**

- Create: `src/loop.ts`, `src/report.ts`, `tests/loop.test.ts`, `tests/report.test.ts`

**Interfaces:**

- Consumes: toàn bộ module trên.
- Produces: `runLoop(deps: {config; projectDir; agents: {implementer: Agent; reviewer: Agent; orchestrator: Agent}; budget: {claude: BudgetTracker; codex: BudgetTracker}}): Promise<RunSummary>` với `RunSummary = {status: 'completed'|'blocked'|'budget'|'repeated-failure'; phases: {id; closed: boolean}[]; tasks: {id; status: 'done'|'BLOCKED'; attempts: number}[]}`; `writePhaseReport(phase, evaluation, commandsRun): string` (đường dẫn file báo cáo); `appendProgress(line): void`.

- [ ] **Step 1: Viết test với agent giả và gate giả** `task done on first green gate`, `task blocked after exactly 3 failing attempts then loop stops`, `stops early on the same fingerprint twice when stopOnRepeatedFailure`, `does not stop early when the option is off`, `confirmed security finding counts as a failed gate`, `advisory review does not fail a green gate`, `phase with a BLOCKED task never advances to the next phase`, `phase closes and report is written only when evaluatePhase is closable`, `stops with status budget when a tracker is exceeded`, `diff guard violation counts as a failed attempt`.
- [ ] **Step 2: Chạy**, kỳ vọng FAIL.
- [ ] **Step 3: Implement** theo sơ đồ người dùng (spec mục 4); logic quyết định chỉ dựa trên kết quả gate/lệnh, không dựa lời agent.
- [ ] **Step 4: Chạy lại**, kỳ vọng PASS.
- [ ] **Step 5: Commit** `feat: loop state machine and reports`.

### Task 11: CLI, từ chối cấu hình sai và chạy khô

**Files:**

- Create: `src/cli.ts`, `tests/cli.test.ts`
- Modify: `package.json` (trường `bin`)

**Interfaces:**

- Produces: `loop-runner check --project <dir>` (nạp cấu hình, in danh sách gate/phase/tiêu chí NOT_RUN, không gọi agent), `loop-runner run --project <dir> [--dry-run]` (`--dry-run` dùng agent giả). Mã thoát khác 0 khi cấu hình thiếu hoặc sai.

- [ ] **Step 1: Viết test** `check exits non-zero and names the problem for a missing config`, `check lists criteria without a command as NOT_RUN`, `run --dry-run completes a one-task sample project`.
- [ ] **Step 2: Chạy**, kỳ vọng FAIL.
- [ ] **Step 3: Implement.** Xin phép người dùng trước khi cài lệnh toàn cục (Task 1, Step 1).
- [ ] **Step 4: Chạy** `pnpm typecheck && pnpm test && pnpm build`, kỳ vọng PASS.
- [ ] **Step 5: Commit** `feat: cli`.

### Task 12: Cấu hình Agent Workspace và đồng bộ giới hạn sửa

**Files:**

- Create (Agent Workspace): `loop.config.json`
- Modify (Agent Workspace): `AGENTS.md` (2 → 3 lần tự sửa), `.codex/agents/implementer.toml` (2 → 3 lần tự sửa)

**Interfaces:**

- Consumes: lược đồ cấu hình của Task 3.

- [ ] **Step 1: Chạy** `loop-runner check --project <Agent Workspace>` khi chưa có `loop.config.json`, kỳ vọng từ chối với thông điệp cụ thể.
- [ ] **Step 2: Tạo `loop.config.json`** với gate `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`, `pnpm build` (thêm `cargo clippy --all-targets -- -D warnings` và `cargo test --locked` khi đụng `src-tauri`), `taskFile: docs/TODO.md`, phase theo ADR-005. Tiêu chí Phase 4–9 chưa có lệnh thì để không có lệnh, để `check` liệt kê NOT_RUN; không bịa lệnh.
- [ ] **Step 3: Đổi** "at most two automatic fix attempts" thành ba trong `AGENTS.md` và `implementer.toml`.
- [ ] **Step 4: Chạy** `loop-runner check --project <Agent Workspace>`, kỳ vọng nạp được và in danh sách tiêu chí NOT_RUN; chạy `pnpm lint && pnpm format && pnpm typecheck && pnpm test && pnpm build` ở Agent Workspace, ghi kết quả thật.
- [ ] **Step 5: Commit** ở Agent Workspace.

### Task 13: Nghiệm thu bằng chạy thật

**Files:**

- Create: `tests/acceptance/` trong repo công cụ (dự án mẫu nhỏ có `loop.config.json`), `docs/reports/LOOP_RUNNER_ACCEPTANCE.md` (Agent Workspace)

**Interfaces:**

- Consumes: toàn bộ công cụ và Task 2 (probe).

- [ ] **Step 1: Chạy thật một task** của Agent Workspace trong worktree riêng: gate xanh, commit, dòng ghi vào `docs/PROGRESS.md`. Chỉ dùng ngân sách nhỏ; người dùng xác nhận trước khi gọi agent thật.
- [ ] **Step 2: Chạy một task cố tình lỗi** (dự án mẫu): xác nhận đúng 3 lần sửa rồi `BLOCKED` và vòng lặp dừng; xác nhận dừng sớm khi cùng lỗi hai lần.
- [ ] **Step 3: Chạy với cấu hình thiếu/sai**: công cụ từ chối, không đoán.
- [ ] **Step 4: Dự án thứ hai**: dự án mẫu nhỏ chạy chỉ bằng cách thêm file cấu hình, không sửa công cụ.
- [ ] **Step 5: Ghi báo cáo nghiệm thu** với lệnh và output thật (PASS/FAIL/BLOCKED/NOT_RUN), kể cả mục chưa kiểm chứng được. Commit.
