# AGENTS.md — Agent Workspace

Codex and other agents working in this repository follow [`CLAUDE.md`](CLAUDE.md) (mandatory principles, workflow, gates). Do not duplicate it here.

Key points for delegated tasks:

- Work only inside the files the task allows; report anything outside as a blocker.
- Spawn processes with an argument array and `shell: false`. Never build shell strings from prompts.
- A git worktree is not a security sandbox. Unverifiable side effects → `needs_reconciliation`, no blind retry.
- No secrets, personal paths or tokens in code, logs or reports. No `git push`, no PRs, no new dependencies.
- Gate before "done": `pnpm lint && pnpm format && pnpm typecheck && pnpm test && pnpm build`. Report PASS/FAIL/BLOCKED/NOT_RUN from real output.
- Role definitions live in `.codex/agents/` (`explorer`, `implementer`, `test-engineer`, `security-reviewer`).
