# ASSUMPTIONS & UNVERIFIED ITEMS

| #   | Item                                                                                       | Status                                                                                                            |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Tauri app launches on Windows                                                              | **Verified on a GitHub `windows-latest` runner (run 41260968950, selftest); **not verified on a physical device** |
| 2   | `cargo check/test` of `src-tauri`                                                          | Passed in CI on `windows-latest` (run 6, 41261272996); not run locally (Linux container lacks WebKitGTK)          |
| 3   | Sidecar spike (ADR-001): Node + `better-sqlite3` + `node-pty` packaged on Windows          | Done on a GitHub Windows runner, see `ADR-001.md`; physical device pending                                        |
| 4   | `better-sqlite3` 13 with `drizzle-orm` 0.45                                                | Pinned to 12.11.1; 13.0.3 failed on Windows (no prebuild). Tests pass on Linux and Windows runners                |
| 5   | Rust crate ages (`tauri` 2.12.5, `tauri-build` 2.7.4)                                      | Age ≥ 14 days **not checked** (npm side is enforced by pnpm only)                                                 |
| 6   | GitHub Actions pinned by tag (`@v4`), not commit SHA                                       | Tighten in Phase 4                                                                                                |
| 7   | Secret scanning (gitleaks)                                                                 | detect-secrets 1.5.0 in CI (`scripts/secret-scan.py`); gitleaks not used (github.com download blocked 403)        |
| 8   | TypeScript 6.0.3 chosen over 7.0.2                                                         | `typescript-eslint` 8.71.2 peer range is `<6.1.0`                                                                 |
| 9   | Tailwind / shadcn / Zustand / TanStack Query                                               | Deferred to Phase 1 UI work (not needed for the health screen)                                                    |
| 10  | No CLI capability (Claude/Codex/Gemini flags, resume, approval) was assumed or implemented | Probes come in Phase 1                                                                                            |
