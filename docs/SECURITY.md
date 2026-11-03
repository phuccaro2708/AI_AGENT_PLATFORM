# SECURITY — Phase 0

## Implemented

- Logger redaction (`shared-utils`): sensitive keys (token, apiKey, secret, password, authorization, cookie, …) are masked, and credential-shaped strings (Bearer, `sk-`, `ghp_`, `AIza…`) are scrubbed from values and messages. Tested. This is best-effort pattern matching, not a guarantee.
- Tauri capability `default` grants only `core:default` — no shell, fs or http plugins. CSP set in `tauri.conf.json`.
- Supply chain: `minimumReleaseAge` 14 days, exact version pins, install scripts allowlisted (`better-sqlite3`, `esbuild` only).
- `.gitignore` excludes `.env*`, `*.db`.
- Agent secrets (Phase 7B): API keys for the CLI agents live in the Windows Credential Manager, written by the native side (`secret_set`/`secret_delete`/`secret_names`). The webview can write or delete a secret and list names; no command returns a value. Secret names must end in `KEY`/`TOKEN`/`SECRET`/`PASSWORD`, so this cannot set `PATH` or `NODE_OPTIONS`. Values reach the sidecar only as `AGENT_STUDIO_SECRET__<PROVIDER>__<NAME>` environment variables at spawn; the sidecar removes them from its own environment at start and passes each agent only its own provider's secrets. Changing a secret restarts the sidecar and is refused while tasks are queued or running. Tested: no secret in the database, logs or IPC responses (`sidecar-secrets.test.ts`); real store round-trip is an opt-in `cargo test -- --ignored`.
- Agent launch settings (Phase 7B): command must resolve to a real executable; extra arguments cannot carry permission, tool, sandbox or working-folder flags; environment settings are an allowlist (proxies, `LANG`, `LC_*`, `TZ`, certificate paths). Settings are saved only after a probe that saw real CLI capabilities.
- Limits: a secret becomes part of the agent process environment, so the agent (and anything it runs) can read it, and a CLI that echoes it into its own output would write it into the task log. Only credential-shaped strings are scrubbed by the logger (best effort). Not an OS sandbox.

## Not implemented yet (do not assume)

- Process spawning (`shell:false`), path scope, command/network policy, approvals, Job Objects — Phase 1/4.
- Secret scanning in CI (see ASSUMPTIONS.md).
- Git worktrees are branch isolation, **not** a security sandbox. Isolation target for 1.0 is in ADR-002 and is explicitly not an OS-level sandbox.
