# Phase 0 — physical Windows verification (Lenovo Legion)

Evidence is **transcribed from console output the user pasted** into the session. The raw files (`spike.log`, `selftest.json`, `commit.txt`, screenshot) exist only on the user's machine and were not committed. Nothing here was run by the assistant.

## Host (as observed in the output)

- Windows (PowerShell), Node `v24.18.0` on the host (CI used v22.23.4), SQLite 3.53.2, WebView2 `Edg/156.0.0.0`.
- Commit under test: **not captured in the pasted output** (`git rev-parse HEAD` output was not shown). The branch was `claude/loving-lovelace-32lh71`, whose head was `d9cf954` at clone time; `commit.txt` on the user's machine should confirm.
- Rust toolchain installed by the user before the run (versions not pasted).

## 1. Sidecar spike — `node scripts/sidecar-spike.mjs` — 11/11 passed

```
PASS  startup + health over stdio IPC — pid=26296 node=v24.18.0 sqlite=3.53.2 ms=4303
PASS  SQLite WAL enabled in sidecar — journal_mode=wal
PASS  runs from isolated dir with bundled node
PASS  invalid request yields error response (no crash)
PASS  StubAdapter task completes — {"finalState":"completed","eventCount":5,"messageCount":6}
PASS  shutdown request exits process with code 0 — code=0 sig=null
PASS  process gone after shutdown
PASS  task persisted across sidecar restart — {"state":"completed","messageCount":6}
PASS  closing stdin exits sidecar (no orphan) — code=0
PASS  killed sidecar leaves no process
PASS  DB intact after hard kill
11/11 checks passed
```

Bundle sizes on Windows: `node.exe` 88.2 MB, `sidecar.mjs` 1.1 MB, `better_sqlite3.node` 1.8 MB. (The "ΓÇö" seen in the raw log is a PowerShell encoding artifact of "—".)

## 2. App selftest through real Tauri IPC — `tauri dev` (debug build) with selftest env vars

`selftest.json`: `ok: true`; `health = {app: "agent-studio", version: "0.0.0"}`; `sidecarHealth = {platform: "win32", node: "v24.18.0", sqlite: "3.53.2", journalMode: "wal", pid: 27296}`; `stub = {finalState: "completed", eventCount: 5, messageCount: 6}`; user agent `Edg/156.0.0.0`.

## 3. Visual check

The user's screenshot showed the window "Agent Studio" with "Runtime: tauri", "App: agent-studio", "Version: 0.0.0". (Image not stored in the repo.)

## 4. Process cleanup

- After the selftest run `Get-Process agent-studio, node` listed only pids 24100 and 24320. Sidecar pid 27296 was **not** listed.
- After closing the window from the second run, `Get-Process agent-studio` returned nothing. `Get-CimInstance Win32_Process` showed pids 24100 and 24320 are `rea-agents\scripts\rea.mjs mcp` (parent 5168), an unrelated tool, not Agent Studio.
- Observation only: WebView2 printed `Failed to unregister class Chrome_WidgetWin_0. Error = 1412` at exit; no effect on results was seen.

## Limits of this verification

- Ran `tauri dev` (debug build, Vite dev server) on the host, not the release `--no-bundle` exe or an installer.
- Sidecar location came from `AGENT_STUDIO_SIDECAR_DIR`; installed-layout packaging is untested.
- Windows Job Objects are not implemented, so process-tree cleanup beyond the sidecar is untested.
- Single machine, single run.
