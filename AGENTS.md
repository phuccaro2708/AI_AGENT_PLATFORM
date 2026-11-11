# AGENTS.md — Agent Workspace

Codex and other agents working in this repository follow [`CLAUDE.md`](CLAUDE.md) (mandatory principles, workflow, gates). Do not duplicate it here.

## Map đọc nhanh

```text
Yêu cầu / quy tắc  → CLAUDE.md (bắt buộc) → mục "Bản đồ dữ liệu" bên dưới
Tiến độ hiện tại   → docs/HANDOFF.md → docs/PROGRESS.md → đối chiếu branch/HEAD
Việc cần làm       → docs/ROADMAP.md → docs/TODO.md → docs/NEXT_PLAN.md
Thiết kế           → docs/ARCHITECTURE.md → docs/DECISIONS.md → mã nguồn
Hành vi thực tế    → apps/, services/, packages/ → tests/ → kết quả chạy tại HEAD
```

[Cây dữ liệu đầy đủ](CLAUDE.md#bản-đồ-dữ-liệu-cho-agent) chỉ đường tới từng nhóm tài liệu và module. Đọc đúng nhánh/worktree trước khi dùng một báo cáo hoặc kết luận tiến độ.

## File changes requested by the user

- Reviews and audits are read-only by default. When the user asks to create, write, update, or fix files, perform the requested file changes within that scope without asking for the same authorization again. A request to write a project plan authorizes creating or updating the relevant documentation files.
- Preserve unrelated working changes. Report the files changed and checks actually run. File-writing authorization does not authorize deletion, installation, credential access, commit, push, publication, or phase closure unless those actions are also requested.

Key points for delegated tasks:

- Work only inside the files the task allows; report anything outside as a blocker.
- Spawn processes with an argument array and `shell: false`. Never build shell strings from prompts.
- A git worktree is not a security sandbox. Unverifiable side effects → `needs_reconciliation`, no blind retry.
- No secrets, personal paths or tokens in code, logs or reports. No `git push`, no PRs, no new dependencies.
- Gate before "done": `pnpm lint && pnpm format && pnpm typecheck && pnpm test && pnpm build`. Report PASS/FAIL/BLOCKED/NOT_RUN from real output.
- Role definitions live in `.codex/agents/` (`explorer`, `implementer`, `test-engineer`, `security-reviewer`).
