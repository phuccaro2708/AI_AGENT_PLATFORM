# ASSUMPTIONS & UNVERIFIED ITEMS

| #   | Item                                                                                       | Status                                                                                     |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Tauri app launches on Windows                                                              | **Not verified** — build container is Linux without `webkit2gtk-4.1`; verify on Windows/CI |
| 2   | `cargo check/test` of `src-tauri`                                                          | **Not verified locally**; depends on the `tauri` CI job                                    |
| 3   | Sidecar spike (ADR-001): Node + `better-sqlite3` + `node-pty` packaged on Windows          | **Not done** — needs Windows                                                               |
| 4   | `better-sqlite3` 13 with `drizzle-orm` 0.45                                                | Works on Linux/Node 22 (tests pass); Windows unverified                                    |
| 5   | Rust crate ages (`tauri` 2.12.5, `tauri-build` 2.7.4)                                      | Age ≥ 14 days **not checked** (npm side is enforced by pnpm only)                          |
| 6   | GitHub Actions pinned by tag (`@v4`), not commit SHA                                       | Tighten in Phase 4                                                                         |
| 7   | Secret scanning (gitleaks)                                                                 | **Deferred** — no scanner configured; manual check only                                    |
| 8   | TypeScript 6.0.3 chosen over 7.0.2                                                         | `typescript-eslint` 8.71.2 peer range is `<6.1.0`                                          |
| 9   | Tailwind / shadcn / Zustand / TanStack Query                                               | Deferred to Phase 1 UI work (not needed for the health screen)                             |
| 10  | No CLI capability (Claude/Codex/Gemini flags, resume, approval) was assumed or implemented | Probes come in Phase 1                                                                     |
