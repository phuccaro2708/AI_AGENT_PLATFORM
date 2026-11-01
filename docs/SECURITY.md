# SECURITY — Phase 0

## Implemented

- Logger redaction (`shared-utils`): sensitive keys (token, apiKey, secret, password, authorization, cookie, …) are masked, and credential-shaped strings (Bearer, `sk-`, `ghp_`, `AIza…`) are scrubbed from values and messages. Tested. This is best-effort pattern matching, not a guarantee.
- Tauri capability `default` grants only `core:default` — no shell, fs or http plugins. CSP set in `tauri.conf.json`.
- Supply chain: `minimumReleaseAge` 14 days, exact version pins, install scripts allowlisted (`better-sqlite3`, `esbuild` only).
- `.gitignore` excludes `.env*`, `*.db`.

## Not implemented yet (do not assume)

- Process spawning (`shell:false`), path scope, command/network policy, approvals, Job Objects — Phase 1/4.
- Secret scanning in CI (see ASSUMPTIONS.md).
- Git worktrees are branch isolation, **not** a security sandbox. Isolation target for 1.0 is in ADR-002 and is explicitly not an OS-level sandbox.
