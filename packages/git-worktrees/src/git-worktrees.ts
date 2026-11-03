import { join, resolve } from "node:path";
import { runProcess } from "@agent-studio/process-manager";

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${String(exitCode)}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

export class WorktreeDirtyError extends Error {
  constructor(
    readonly path: string,
    readonly files: readonly string[],
  ) {
    super(`Worktree has uncommitted changes (${files.length} file(s)): ${path}`);
    this.name = "WorktreeDirtyError";
  }
}

export class PathTooLongError extends Error {
  constructor(
    readonly path: string,
    readonly limit: number,
  ) {
    super(`Worktree path is ${path.length} characters, over the limit of ${limit}: ${path}`);
    this.name = "PathTooLongError";
  }
}

export interface GitWorktreesOptions {
  /** The main checkout the worktrees hang off. */
  repoRoot: string;
  /** Parent directory for every worktree. Keep it short: long paths fail on Windows (docs/ASSUMPTIONS.md). */
  baseDir: string;
  /** Default `git`. */
  gitCommand?: string;
  /** Refuse to create a worktree whose path is longer than this. Default 200 (Windows MAX_PATH is 260). */
  maxPathLength?: number;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
  /** The commit `baseRef` resolved to when the worktree was created. */
  baseSha: string;
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  /** Short branch name, absent when detached. */
  branch?: string;
  /** The directory is gone or unusable; `prune` removes the record. */
  prunable: boolean;
}

export interface WorktreeStatus {
  dirty: boolean;
  files: { path: string; code: string }[];
}

export interface MergeCheck {
  clean: boolean;
  conflicts: string[];
}

/** Compares paths the way the OS does (git prints forward slashes; Windows is case-insensitive). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Ids come from outside; keep only safe characters and a short readable tail. */
function shorten(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  const tail = safe.includes("_") ? safe.slice(safe.indexOf("_") + 1) : safe;
  return (tail || safe || "x").slice(-12);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin, argument-array wrapper around `git worktree`. A worktree isolates files between tasks; it is NOT
 * a security boundary: a process started inside one can still write anywhere the user can (CLAUDE.md #5).
 * Nothing here merges into the main branch; `checkMerge` only reports conflicts.
 */
export class GitWorktrees {
  private readonly repoRoot: string;
  private readonly baseDir: string;
  private readonly gitCommand: string;
  private readonly maxPathLength: number;

  constructor(opts: GitWorktreesOptions) {
    this.repoRoot = opts.repoRoot;
    this.baseDir = opts.baseDir;
    this.gitCommand = opts.gitCommand ?? "git";
    this.maxPathLength = opts.maxPathLength ?? 200;
  }

  branchName(workflowId: string, taskId: string): string {
    return `agent-studio/${shorten(workflowId)}/${shorten(taskId)}`;
  }

  pathFor(workflowId: string, taskId: string): string {
    return join(this.baseDir, `${shorten(workflowId)}-${shorten(taskId)}`);
  }

  async create(opts: {
    workflowId: string;
    taskId: string;
    /** Default `HEAD` of the main checkout. */
    baseRef?: string;
  }): Promise<WorktreeInfo> {
    const path = this.pathFor(opts.workflowId, opts.taskId);
    if (path.length > this.maxPathLength) throw new PathTooLongError(path, this.maxPathLength);
    const branch = this.branchName(opts.workflowId, opts.taskId);
    const baseRef = opts.baseRef ?? "HEAD";
    const baseSha = (await this.git(["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
    await this.git(["worktree", "add", "-b", branch, path, baseSha]);
    return { path, branch, baseRef, baseSha };
  }

  async list(): Promise<WorktreeEntry[]> {
    const out = await this.git(["worktree", "list", "--porcelain"]);
    const entries: WorktreeEntry[] = [];
    for (const block of out.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/).filter((l) => l !== "");
      const first = lines[0];
      if (!first?.startsWith("worktree ")) continue;
      const entry: WorktreeEntry = { path: first.slice("worktree ".length), prunable: false };
      for (const line of lines.slice(1)) {
        if (line.startsWith("HEAD ")) entry.head = line.slice(5);
        else if (line.startsWith("branch "))
          entry.branch = line.slice(7).replace(/^refs\/heads\//, "");
        else if (line === "prunable" || line.startsWith("prunable ")) entry.prunable = true;
      }
      entries.push(entry);
    }
    return entries;
  }

  async status(path: string): Promise<WorktreeStatus> {
    const out = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], path);
    const parts = out.split("\0");
    const files: WorktreeStatus["files"] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i] ?? "";
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      files.push({ path: entry.slice(3), code });
      if (code[0] === "R" || code[0] === "C") i++; // the next field is the original path
    }
    return { dirty: files.length > 0, files };
  }

  /** Refuses a dirty worktree unless `force`. Retries because Windows may briefly hold file handles. */
  async remove(
    path: string,
    opts: { force?: boolean; deleteBranch?: boolean } = {},
  ): Promise<void> {
    const branch = (await this.list()).find((w) => samePath(w.path, path))?.branch;
    if (!opts.force) {
      const s = await this.status(path);
      if (s.dirty)
        throw new WorktreeDirtyError(
          path,
          s.files.map((f) => f.path),
        );
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.git(["worktree", "remove", ...(opts.force ? ["--force"] : []), path]);
        lastError = undefined;
        break;
      } catch (e) {
        lastError = e;
        await sleep(250 * (attempt + 1));
      }
    }
    if (lastError) throw lastError;
    await this.prune();
    if (opts.deleteBranch && branch) {
      await this.git(["branch", opts.force ? "-D" : "-d", branch]);
    }
  }

  async prune(): Promise<void> {
    await this.git(["worktree", "prune"]);
  }

  /**
   * Would merging `branch` into `into` conflict? Uses `git merge-tree`, which writes no working tree or
   * ref. The result can go stale as soon as either branch moves.
   */
  async checkMerge(branch: string, into: string): Promise<MergeCheck> {
    const r = await this.run(
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", into, branch],
      this.repoRoot,
    );
    if (r.exitCode === 0) return { clean: true, conflicts: [] };
    if (r.exitCode !== 1) throw new GitError(["merge-tree"], r.exitCode, r.stderr);
    const lines = r.stdout.split(/\r?\n/);
    const conflicts: string[] = [];
    for (const line of lines.slice(1)) {
      if (line === "") break;
      conflicts.push(line);
    }
    return { clean: false, conflicts };
  }

  private async run(args: readonly string[], cwd: string) {
    const r = await runProcess({
      command: this.gitCommand,
      args,
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 60_000,
    });
    if (r.outcome !== "exited") {
      throw new GitError(args, r.exitCode, r.error ?? `git ${r.outcome}`);
    }
    return r;
  }

  private async git(args: readonly string[], cwd: string = this.repoRoot): Promise<string> {
    const r = await this.run(args, cwd);
    if (r.exitCode !== 0) throw new GitError(args, r.exitCode, r.stderr);
    return r.stdout;
  }
}
