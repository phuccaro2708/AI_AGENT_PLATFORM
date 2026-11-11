# AGENTS.md — Agent Workspace

Codex và các agent khác làm việc trong repo này theo [`CLAUDE.md`](CLAUDE.md). Không lặp lại nội dung ở đây.

- Đang ở đâu: `docs/HANDOFF.md`. Làm gì tiếp: `docs/ROADMAP.md`, `docs/TODO.md`. Đối chiếu với nhánh và HEAD trước khi tin tài liệu.
- Review và audit mặc định chỉ đọc. Khi người dùng yêu cầu tạo/sửa file thì làm trong đúng phạm vi đó; quyền ghi file không bao gồm xoá, cài đặt, commit, push.
- Spawn process bằng argument array, `shell: false`. Git worktree không phải sandbox.
- Không secrets, đường dẫn cá nhân hay token trong mã, log, báo cáo. Không `git push`, không PR, không dependency mới.
- Gate trước khi báo xong: `pnpm lint && pnpm format && pnpm typecheck && pnpm test && pnpm build`. Báo PASS/FAIL/NOT_RUN theo kết quả thật.
