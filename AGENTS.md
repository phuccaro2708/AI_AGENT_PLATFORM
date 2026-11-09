# AGENTS.md — Agent Workspace

Codex and other agents working in this repository follow [`CLAUDE.md`](CLAUDE.md) (mandatory principles, workflow, gates). Do not duplicate it here.

Key points for delegated tasks:

- Work only inside the files the task allows; report anything outside as a blocker.
- Spawn processes with an argument array and `shell: false`. Never build shell strings from prompts.
- A git worktree is not a security sandbox. Unverifiable side effects → `needs_reconciliation`, no blind retry.
- No secrets, personal paths or tokens in code, logs or reports. No `git push`, no PRs, no new dependencies.
- Gate before "done": `pnpm lint && pnpm format && pnpm typecheck && pnpm test && pnpm build`. Report PASS/FAIL/BLOCKED/NOT_RUN from real output.
- Role definitions live in `.codex/agents/` (`explorer`, `implementer`, `test-engineer`, `security-reviewer`).

Roles and sandbox (from `.codex/agents/*.toml`):

| Role                | Sandbox         | Does                                                     | Must not                                               |
| ------------------- | --------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `explorer`          | read-only       | Investigate files/logs, return evidence with `file:line` | Edit files, run side-effect commands                   |
| `implementer`       | workspace-write | Implement one bounded task and its tests                 | Redesign, change phase order, close phases             |
| `test-engineer`     | workspace-write | Write/run tests, report PASS/FAIL/BLOCKED/NOT_RUN        | Weaken or skip tests, raise timeouts to hide flakiness |
| `security-reviewer` | read-only       | Independent review of policy, IPC, secrets, spawning     | Modify files, execute repository code                  |

Automatic loop mode (see `CLAUDE.md` principle 10):

- Claude is the orchestrator: it plans, delegates, runs the gates and decides whether a task or phase is done. Codex roles never close a task queue or a phase; they return a status and evidence.
- Per task: at most three automatic fix attempts, then report `blocked`. A blocked task stops the phase; do not skip ahead.
- Independent review: the code reviewer role is a read-only Codex run on the diff, separate from the one that wrote the code.
- Still forbidden for every role: `git push`, pull requests, new dependencies, edits outside the allowed files.
- Not yet defined as role files (roles in the team plan without a `.codex/agents/` entry): frontend, database, performance, devops, code-reviewer. Add a role file before delegating to one; do not improvise its restrictions.
