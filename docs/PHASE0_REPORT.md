# PHASE 0 REPORT

Environment: Linux container, Node v22.23.4, pnpm 10.28.0, rustc 1.97.0. **No Windows, no `webkit2gtk-4.1`.**

## Commands executed (local) and results

| Command                                                     | Result                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm install` (via `pnpm add`, `minimumReleaseAge: 20160`) | OK; `better-sqlite3` native build succeeded                                 |
| `pnpm lint`                                                 | pass (no errors)                                                            |
| `pnpm format` (prettier --check)                            | pass                                                                        |
| `pnpm typecheck`                                            | pass (all packages, `tsc --noEmit`)                                         |
| `pnpm test` (vitest)                                        | **5 files, 23 tests passed**                                                |
| `pnpm build`                                                | pass (`tsc` for packages/service, `tsc --noEmit && vite build` for desktop) |
| Runtime smoke of built `dist` (stub task via Node)          | printed `completed 5 6` (final state, events, persisted messages)           |
| `drizzle-kit generate`                                      | produced `packages/storage/drizzle/0000_*.sql` (7 tables)                   |
| `cargo generate-lockfile` (src-tauri)                       | OK; `Cargo.lock` committed                                                  |

Test coverage: contracts parse/reject; redaction + logger never emits secrets; StubAdapter determinism, AbortSignal and `cancel()`; registry; migrations idempotent on a temp file DB, WAL + FK on, CHECK/UNIQUE constraints, atomic state+event, persistence across reopen; orchestrator stub end-to-end (completed, cancelled, unknown agent).

## Acceptance gate

| Criterion                                    | Status                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop app launches                         | **NOT VERIFIED** — cannot build Tauri here (missing WebKitGTK; target is Windows). The React frontend builds with `vite build`. Next: run `pnpm --filter @agent-studio/desktop tauri dev` on the Legion/Windows, or rely on the `tauri` CI job (which only runs `cargo check/test`, it does not launch the app). |
| Migrations succeed from empty DB, idempotent | Pass (tests)                                                                                                                                                                                                                                                                                                     |
| Stub agent emits structured events           | Pass (events validated against Zod)                                                                                                                                                                                                                                                                              |
| lint / typecheck / test / build              | Pass locally (Linux)                                                                                                                                                                                                                                                                                             |
| No secrets / personal paths committed        | Manual check only; **no automated secret scan** (deferred, ASSUMPTIONS #7)                                                                                                                                                                                                                                       |
| Assumptions documented                       | Done: `docs/ASSUMPTIONS.md`                                                                                                                                                                                                                                                                                      |
| Sidecar spike (ADR-001)                      | **NOT DONE** — needs Windows                                                                                                                                                                                                                                                                                     |

**Phase 0 is therefore not fully closed**: the "app launches" and sidecar-spike items remain open.

## CI

`.github/workflows/ci.yml` (ubuntu + windows TS jobs; windows Rust job). At the time of writing, the GitHub Actions API returned **no runs** for this branch, so CI results are unknown — do not treat CI as passing.

## Deviations from the plan

- Tailwind/shadcn/Zustand/TanStack Query not added yet (health screen doesn't need them).
- TypeScript pinned to 6.0.3 (7.0.2 breaks `typescript-eslint` peer range).
- `tauri icon` generated placeholder (solid colour) icons; android/ios outputs removed.
- Only `core:default` Tauri capability; CSP set; no plugins.

## Outstanding issues / next steps

1. Run the app on Windows; run the sidecar spike; record in ADR-001.
2. Confirm CI runs (Actions enabled?) and read real results.
3. Add a pinned secret scanner.
4. Start Phase 1: process manager (`shell:false`, tree-kill), CLI detection + compatibility probes, Claude/Codex adapters with recorded fixtures.
