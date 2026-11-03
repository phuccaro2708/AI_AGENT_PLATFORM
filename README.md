# Agent Workspace

Desktop platform (Windows-first, local-first) cho phép Claude Code, Codex, Gemini CLI và Local AI (Ollama) phối hợp, chạy song song trên Git worktree riêng và kiểm tra chéo kết quả, có human-in-the-loop.

**Trạng thái:** đang ở giai đoạn lập kế hoạch (trước Phase 0).

- Quy tắc cho Claude Code và chính sách tham khảo repo công khai: [`CLAUDE.md`](CLAUDE.md)
- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- TODO chi tiết: [`docs/TODO.md`](docs/TODO.md)

Stack: Tauri 2 + React + TypeScript (UI), Node.js + TypeScript (orchestrator), Rust (native), SQLite + Drizzle, pnpm monorepo.
