import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runProcess } from "@agent-studio/process-manager";

/** Task ids become branch and directory names, so only a conservative alphabet is accepted. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function assertSafeId(taskId: string): void {
  if (
    !SAFE_ID.test(taskId) ||
    taskId.includes("..") ||
    taskId.endsWith(".") ||
    taskId.endsWith(".lock")
  )
    throw new Error(`unsafe task id for a worktree: ${JSON.stringify(taskId)}`);
}

export function branchNameFor(taskId: string): string {
  assertSafeId(taskId);
  return `agent/${taskId}`;
}

export interface WorktreeInfo {
  taskId: string;
  path: string;
  branch: string;
  baseSha: string;
}

/** What `list()` can know from git alone: the current HEAD, not the base the worktree was cut from. */
export type ListedWorktree = Omit<WorktreeInfo, "baseSha"> & { headSha: string };

export interface GitWorktreesOptions {
  repoRoot: string;
  /** Default: `<git-common-dir>/agent-studio/worktrees` (inside .git: untracked, never in `git status`). */
  baseDir?: string;
}

/**
 * Per-task git worktrees. A worktree is branch isolation, NOT a security sandbox (CLAUDE.md #5):
 * an agent running in it can still touch any file its OS user can.
 */
export class GitWorktrees {
  private readonly repoRoot: string;
  private baseDir: string | undefined;
  /** `git worktree add/remove` take repo-level locks; serialising them avoids spurious lock errors. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: GitWorktreesOptions) {
    this.repoRoot = resolve(opts.repoRoot);
    this.baseDir = opts.baseDir ? resolve(opts.baseDir) : undefined;
  }

  private async git(args: string[], cwd = this.repoRoot, okCodes: number[] = [0]) {
    const r = await runProcess({ command: "git", args, cwd, timeoutMs: 60_000 });
    if (r.outcome !== "exited" || r.exitCode === null || !okCodes.includes(r.exitCode))
      throw new Error(
        `git ${args[0]} failed (${r.outcome}, ${r.exitCode}): ${r.stderr.trim() || r.error || ""}`,
      );
    return r;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async base(): Promise<string> {
    if (!this.baseDir) {
      const out = (await this.git(["rev-parse", "--git-common-dir"])).stdout.trim();
      const common = isAbsolute(out) ? out : resolve(this.repoRoot, out);
      this.baseDir = join(common, "agent-studio", "worktrees");
    }
    return this.baseDir;
  }

  private pathFor = async (taskId: string) => join(await this.base(), taskId);

  async create(o: { taskId: string; baseRef?: string }): Promise<WorktreeInfo> {
    const branch = branchNameFor(o.taskId);
    const baseRef = o.baseRef ?? "HEAD";
    if (baseRef.startsWith("-")) throw new Error(`invalid base ref: ${baseRef}`);
    return this.serial(async () => {
      const path = await this.pathFor(o.taskId);
      const sha = await this.git(
        ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`],
        this.repoRoot,
        [0, 1],
      );
      if (sha.exitCode !== 0) throw new Error(`base ref not found: ${baseRef}`);
      const baseSha = sha.stdout.trim();
      const existing = await this.git(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        this.repoRoot,
        [0, 1],
      );
      if (existing.exitCode === 0) throw new Error(`branch already exists: ${branch}`);
      await mkdir(await this.base(), { recursive: true });
      await this.git(["worktree", "add", "-b", branch, path, baseSha]);
      return { taskId: o.taskId, path, branch, baseSha };
    });
  }

  /** Uncommitted state of a worktree (untracked files count). */
  async status(path: string): Promise<{ dirty: boolean; files: string[] }> {
    const out = (await this.git(["status", "--porcelain", "-z", "--untracked-files=all"], path))
      .stdout;
    // -z records: "XY path\0" (renames add a second path field, which we skip)
    const files = out
      .split("\0")
      .filter((e) => e.length > 3 && e[2] === " ")
      .map((e) => e.slice(3));
    return { dirty: files.length > 0, files };
  }

  /**
   * Would merging `branch` into `into` conflict? Uses an in-memory merge (`merge-tree --write-tree`,
   * git >= 2.38): no working tree or index is touched, although it may write unreferenced objects.
   */
  async detectConflicts(into: string, branch: string): Promise<{ conflicts: string[] }> {
    for (const r of [into, branch]) if (r.startsWith("-")) throw new Error(`invalid ref: ${r}`);
    const r = await this.git(
      ["merge-tree", "--write-tree", "--name-only", "-z", into, branch],
      this.repoRoot,
      [0, 1],
    );
    if (r.exitCode === 0) return { conflicts: [] };
    // stdout: "<tree>\0<file>\0...\0\0<messages>"; files come before the empty separator field
    const parts = r.stdout.split("\0");
    const files: string[] = [];
    for (const p of parts.slice(1)) {
      if (p === "") break;
      files.push(p);
    }
    return { conflicts: [...new Set(files)].sort() };
  }

  /**
   * Removes the task's worktree. A dirty worktree is refused unless `force`. The branch (and so the
   * committed work) is kept unless `deleteBranch`. Unknown tasks are a no-op (idempotent cleanup).
   */
  async remove(o: { taskId: string; force?: boolean; deleteBranch?: boolean }): Promise<void> {
    const branch = branchNameFor(o.taskId);
    await this.serial(async () => {
      const path = await this.pathFor(o.taskId);
      const known = (await this.listUnlocked()).some((w) => w.taskId === o.taskId);
      if (known) {
        if (!o.force) {
          const st = await this.status(path);
          if (st.dirty)
            throw new Error(
              `worktree has uncommitted changes (${st.files.length} files); use force`,
            );
        }
        await this.git(["worktree", "remove", "--force", path]);
      }
      await this.git(["worktree", "prune"]);
      if (o.deleteBranch) {
        const b = await this.git(
          ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
          this.repoRoot,
          [0, 1],
        );
        if (b.exitCode === 0) await this.git(["branch", "-D", branch]);
      }
    });
  }

  async list(): Promise<ListedWorktree[]> {
    return this.serial(() => this.listUnlocked());
  }

  private async listUnlocked(): Promise<ListedWorktree[]> {
    const base = (await this.base()).replaceAll("\\", "/").toLowerCase();
    const out = (await this.git(["worktree", "list", "--porcelain"])).stdout;
    const result: ListedWorktree[] = [];
    for (const block of out.split(/\r?\n\r?\n/)) {
      const f = Object.fromEntries(
        block.split(/\r?\n/).map((l) => {
          const i = l.indexOf(" ");
          return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)];
        }),
      );
      const path = f["worktree"];
      if (!path || !f["branch"]) continue;
      const norm = path.replaceAll("\\", "/");
      if (!norm.toLowerCase().startsWith(base + "/")) continue;
      result.push({
        taskId: norm.slice(base.length + 1),
        path: resolve(path),
        branch: f["branch"].replace(/^refs\/heads\//, ""),
        headSha: f["HEAD"] ?? "",
      });
    }
    return result;
  }
}
