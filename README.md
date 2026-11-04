# Agent Workspace

Desktop platform (Windows-first, local-first) cho phép Claude Code, Codex, các CLI agent khác tự quét được trên máy (như Antigravity) và Local AI (Ollama) phối hợp, chạy song song trên Git worktree riêng và kiểm tra chéo kết quả, có human-in-the-loop.

**Trạng thái:** Phase 0–2 đã đóng, Phase 7 đang làm (xem [`docs/HANDOFF.md`](docs/HANDOFF.md) và [`docs/PROGRESS.md`](docs/PROGRESS.md)). Chỉ `claude` và `codex` chạy được task; các CLI khác mới được phát hiện.

- Quy tắc cho Claude Code và chính sách tham khảo repo công khai: [`CLAUDE.md`](CLAUDE.md)
- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- TODO chi tiết: [`docs/TODO.md`](docs/TODO.md)

Stack: Tauri 2 + React + TypeScript (UI), Node.js + TypeScript (orchestrator), Rust (native), SQLite + Drizzle, pnpm monorepo.
