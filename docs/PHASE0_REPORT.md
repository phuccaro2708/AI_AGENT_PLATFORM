# PHASE 0 REPORT

Branch: `claude/loving-lovelace-32lh71`. Repository: `phuccaro2708/AI_AGENT_PLATFORM`.

**Verdict: PHASE 0 BLOCKED.** All automated gates pass on GitHub-hosted runners, but there is **no verification on a physical Windows device** (see "Windows host verification"). Phase 0 must not be treated as closed until that is done.

Evidence in this report comes from two places and they are kept separate:

- **Linux dev container** (Node v22.23.4, pnpm 10.28.0, rustc 1.97.0; no WebKitGTK, so Tauri cannot be built there).
- **GitHub-hosted runners** (`ubuntu-latest`, `windows-latest`). These are **not** a physical Windows machine.

## CI history (what actually happened)

| Run (ID)          | Commit    | Result      | Cause / note                                                                                                                                                                                 |
| ----------------- | --------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (`41260082562`) | `6d4977c` | failure     | job logs **not inspected**; the same code failed in run 2 for the cause below (assumed, not verified for run 1)                                                                              |
| 2 (`41260106056`) | `1650662` | failure     | `better-sqlite3@13.0.3` has no `prebuild-install`; `node-gyp` found no usable Visual Studio on `windows-latest` (TypeScript Windows job `124711427401`). Ubuntu and Rust Windows jobs passed |
| 3 (`41260535795`) | `2367e00` | failure     | install fixed by pinning `better-sqlite3@12.11.1`; `pnpm format` failed on Windows (CRLF checkout)                                                                                           |
| 4 (`41260951249`) | `d4e1b0b` | not read    | pushed together with the next fix; superseded, result not inspected                                                                                                                          |
| 5 (`41260968950`) | `21c1ae9` | failure     | only **Security** failed: `detect-secrets` flagged its own package name in `ci.yml` (false positive). TypeScript ubuntu/Windows, Rust, and desktop job `124713975484` succeeded              |
| 6 (`41261272996`) | `865e541` | **success** | all 5 jobs green                                                                                                                                                                             |
| 7 (`41261599040`) | `5c995db` | see below   | docs-only commit (ADR-001)                                                                                                                                                                   |

Repair iterations used: 3 of 3 allowed in effect (better-sqlite3 pin, `.gitattributes`, secret-scan allowlist). No test was disabled or skipped to obtain green.

## Verification table

| Gate                                                                 | Status                        | Evidence                                                                                                                                                                                                                                                    | Remaining action                        |
| -------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| TypeScript lint, format, typecheck, test, build — Ubuntu runner      | PASS                          | run 6 `41261272996`, commit `865e541`, job `124714874940`                                                                                                                                                                                                   | none                                    |
| Same — Windows runner                                                | PASS                          | run 6, job `124714874969` (needed the `better-sqlite3@12.11.1` pin and `.gitattributes`)                                                                                                                                                                    | none                                    |
| Rust `cargo check --locked` + `cargo test --locked` — Windows runner | PASS                          | run 6, job `124714875068` (run conclusion: success)                                                                                                                                                                                                         | none                                    |
| Tauri app builds and launches — **GitHub Windows runner**            | PASS                          | run 5 job `124713975484`: `tauri build --no-bundle` built `agent-studio.exe` (4m25s); app launched in selftest mode; run 6 job `124714874852` also green                                                                                                    | **also verify on a physical device**    |
| `system_health` through Tauri IPC — GitHub Windows runner            | PASS                          | run 5 selftest report: `health = {app:"agent-studio", version:"0.0.0"}`, `ok: true`, webview `Edg/155.0.0.0` (WebView2)                                                                                                                                     | physical device                         |
| Node sidecar startup + IPC + StubAdapter + SQLite — Windows runner   | PASS                          | run 5 spike driver 11/11 on `win32`; selftest `sidecarHealth = {platform:"win32", node:"v22.23.4", sqlite:"3.53.2", journalMode:"wal", pid:2328}`; `stub = {finalState:"completed", eventCount:5, messageCount:6}`                                          | physical device                         |
| SQLite persists across sidecar restart — Windows runner              | PASS                          | spike check "task persisted across sidecar restart" (`completed`, 6 messages), also after a hard kill ("DB intact after hard kill")                                                                                                                         | physical device                         |
| Clean shutdown / no orphan — Windows runner                          | PASS                          | spike: `shutdown` exit code 0, process gone; stdin close exits sidecar; killed sidecar leaves no process. Selftest: `sidecar pid 2328 is gone after app exit`                                                                                               | Job Objects (Phase 4) for process trees |
| Migrations from empty DB, idempotent                                 | PASS                          | unit tests (`packages/storage`) run in CI on ubuntu and Windows                                                                                                                                                                                             | none                                    |
| StubAdapter emits validated events                                   | PASS                          | unit tests (`packages/agent-core`)                                                                                                                                                                                                                          | none                                    |
| Secret scan                                                          | PASS (with accepted findings) | run 6 job `124714874931`: `scanned worktree + 10 commits; findings: 0 (accepted fixture hits: 7)`. Tool: `detect-secrets 1.5.0` via `scripts/secret-scan.py`. gitleaks was not used (download from `github.com` was blocked by the sandbox proxy, HTTP 403) | pin and add gitleaks later if wanted    |
| `pnpm audit`                                                         | PASS at high/critical         | 2 **moderate**, both dev-only: `minimatch <11.0.1` via `eslint`; `esbuild <=0.24.2` via `drizzle-kit`. `--prod`: none. CI fails on high or critical                                                                                                         | upgrade when compatible versions exist  |
| `cargo audit`                                                        | PASS                          | run 6, `cargo-audit 0.22.2`, 1395 advisories, 407 crates: 0 vulnerabilities, 2 allowed warnings — `RUSTSEC-2024-0370` (`proc-macro-error` unmaintained), `RUSTSEC-2024-0429` (`glib 0.18.5` unsound)                                                        | transitive (Tauri/GTK); watch upstream  |
| ADR-001 (sidecar) written with evidence                              | PASS                          | `docs/ADR-001.md`                                                                                                                                                                                                                                           | none                                    |
| **Windows host verification (physical Legion)**                      | **BLOCKED**                   | WinApps MCP not available; no computer connected through Remote Control (`list_computer_folders` returned empty). Nothing was run on a physical device                                                                                                      | run the manual commands below           |
| CI on the final commit                                               | see below                     | —                                                                                                                                                                                                                                                           | —                                       |

### Accepted findings

- 5 history snapshots contain the **fake** fixture value `SUPERSECRET1` in the logger-redaction test (before the inline `pragma: allowlist secret` existed). 2 snapshots contain the `detect-secrets==1.5.0` package name flagged by the scanner's own keyword rule. All 7 are listed with exact (commit, file, type, line) in `scripts/secret-scan.py`; none are credentials.
- The two moderate `pnpm audit` findings and the two `cargo audit` warnings above are not fixed; they are dev-tool or transitive and were judged non-blocking for Phase 0.

## Windows host verification (BLOCKED) — manual commands

Run on the Legion, PowerShell, repository root, on this branch. Save outputs under `docs/reports/phase0-windows/` (does not exist yet; **no results exist**).

```powershell
New-Item -ItemType Directory -Force docs\reports\phase0-windows | Out-Null
git rev-parse HEAD | Tee-Object docs\reports\phase0-windows\commit.txt
node -v; pnpm -v; rustc -V; cargo -V
pnpm install --frozen-lockfile
node scripts/build-sidecar.mjs
$env:SPIKE_REPORT = "$PWD\docs\reports\phase0-windows\spike-report.json"
node scripts/sidecar-spike.mjs *> docs\reports\phase0-windows\spike.log
```

```powershell
# App + IPC + sidecar, self-terminating
$env:AGENT_STUDIO_SIDECAR_DIR = "$PWD\services\orchestrator\sidecar-dist"
$env:AGENT_STUDIO_SELFTEST_OUT = "$PWD\docs\reports\phase0-windows\selftest.json"
$env:AGENT_STUDIO_DB = "$env:TEMP\selftest.db"
pnpm --filter @agent-studio/desktop tauri dev
```

Expected: `selftest.json` has `"ok": true` and `stub.finalState = "completed"`; `Get-Process agent-studio, node` shows nothing afterwards. Then run `tauri dev` without `AGENT_STUDIO_SELFTEST_OUT`, take a screenshot of the health screen ("Runtime: tauri", "App: agent-studio", "Version: 0.0.0"), and close the window. The UI has no button; it calls `system_health` on load.

## Local commands (Linux container)

| Command                                                            | Result                                |
| ------------------------------------------------------------------ | ------------------------------------- |
| `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm build`         | pass                                  |
| `pnpm test`                                                        | 6 files, 27 tests passed              |
| `node scripts/build-sidecar.mjs && node scripts/sidecar-spike.mjs` | 11/11 checks passed                   |
| `scripts/secret-scan.py` (detect-secrets in a venv)                | 0 findings, 7 accepted                |
| `pnpm audit`                                                       | 2 moderate (dev-only), `--prod` clean |

## Deviations and caveats

- `better-sqlite3` pinned to `12.11.1`, not 13.x (see ADR-001).
- TypeScript pinned to `6.0.3` because `typescript-eslint` 8.71.2 does not support 7.x.
- Tailwind, shadcn, Zustand and TanStack Query were not added (the health screen does not need them).
- The Tauri installer was not built; only `--no-bundle` release builds. Installer size is unmeasured.
- Rust crate ages for `tauri 2.12.5` / `tauri-build 2.7.4` were not checked against the 14-day rule (pnpm enforces it only for npm packages).
- GitHub Actions are pinned by tag (`@v4`), not by commit SHA. Node.js 20 deprecation warnings appear for those actions.
- The selftest and sidecar spike verify the Phase 0 skeleton only; no real CLI adapter exists.

## Next required action

Run the manual Windows commands above on the Legion (or connect it via Remote Control / WinApps MCP), commit the evidence under `docs/reports/phase0-windows/`, and re-evaluate. If it passes, Phase 0 can be marked PASS and Phase 1 planning can start.
