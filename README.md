# Agent Workspace

Công cụ desktop cá nhân (Windows, chạy cục bộ) để giao việc cho **Claude Code** và **Codex** từ một giao diện: chạy task đơn, hoặc Peer Review (một agent viết trong Git worktree riêng, agent kia kiểm tra chỉ-đọc).

Phạm vi: dùng cho một người trên một máy. Không có installer, ký mã, auto-update hay sandbox hệ điều hành (xem [`docs/DECISIONS.md`](docs/DECISIONS.md) ADR-010).

- Việc tiếp theo: [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/TODO.md`](docs/TODO.md)
- Đang ở đâu: [`docs/HANDOFF.md`](docs/HANDOFF.md)
- Quy tắc làm việc cho agent: [`CLAUDE.md`](CLAUDE.md)

Stack: Tauri 2 + React + TypeScript (UI), Node.js + TypeScript (sidecar), Rust (vỏ native), SQLite + Drizzle, pnpm monorepo.

Chạy thử: `pnpm install`, rồi `pnpm --filter @agent-studio/desktop tauri dev`. Kiểm tra trước khi commit: `pnpm lint && pnpm format && pnpm typecheck && pnpm test && pnpm build`.
