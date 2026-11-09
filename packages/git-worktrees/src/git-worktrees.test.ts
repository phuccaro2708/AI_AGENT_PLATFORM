import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GitError,
  GitWorktrees,
  PathTooLongError,
  WorktreeDirtyError,
  samePath,
} from "./git-worktrees.js";

let root: string; // scratch dir holding the repo and the worktrees dir
let repo: string;
let base: string;
let wt: GitWorktrees;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "as-wt-"));
  repo = join(root, "repo");
  base = join(root, "wt");
  git(root, "init", "-q", "-b", "main", "repo");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  wt = new GitWorktrees({ repoRoot: repo, baseDir: base });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("create / list", () => {
  it("creates a worktree on its own namespaced branch at the base commit", async () => {
    const info = await wt.create({ workflowId: "wf_abc12345", taskId: "task_def67890" });
    expect(info.branch).toBe("agent-studio/abc12345/def67890"); // pragma: allowlist secret (fake ids)
    expect(existsSync(join(info.path, "a.txt"))).toBe(true);
    expect(info.baseSha).toBe(git(repo, "rev-parse", "HEAD"));
    const listed = await wt.list();
    expect(listed.some((w) => samePath(w.path, info.path) && w.branch === info.branch)).toBe(true);
  });

  it("two worktrees edit the same file without overwriting each other or the main tree", async () => {
    const a = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    const b = await wt.create({ workflowId: "wf_1", taskId: "task_b" });
    writeFileSync(join(a.path, "a.txt"), "A\n");
    writeFileSync(join(b.path, "a.txt"), "B\n");
    expect(readFileSync(join(a.path, "a.txt"), "utf8")).toBe("A\n");
    expect(readFileSync(join(b.path, "a.txt"), "utf8")).toBe("B\n");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("refuses a second worktree for the same task (branch already exists)", async () => {
    await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    await expect(wt.create({ workflowId: "wf_1", taskId: "task_a" })).rejects.toThrow(GitError);
  });

  it("keeps hostile ids inside the worktrees directory", async () => {
    const info = await wt.create({ workflowId: "../../evil", taskId: "..\\x/y" });
    expect(resolve(info.path).startsWith(resolve(base))).toBe(true);
    expect(info.branch).toMatch(/^agent-studio\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
  });

  it("rejects a path that would exceed the Windows-safe length before calling git", async () => {
    const long = new GitWorktrees({
      repoRoot: repo,
      baseDir: join(base, "x".repeat(150)),
      maxPathLength: 120,
    });
    await expect(long.create({ workflowId: "wf_1", taskId: "t" })).rejects.toThrow(
      PathTooLongError,
    );
  });
});

describe("status", () => {
  it("reports clean, modified and untracked files", async () => {
    const info = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    expect(await wt.status(info.path)).toEqual({ dirty: false, files: [] });
    writeFileSync(join(info.path, "a.txt"), "changed\n");
    writeFileSync(join(info.path, "new file.txt"), "x");
    const s = await wt.status(info.path);
    expect(s.dirty).toBe(true);
    expect(s.files.map((f) => f.path).sort()).toEqual(["a.txt", "new file.txt"]);
  });
});

describe("diff", () => {
  it("shows modified and untracked files without staging anything", async () => {
    const info = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    expect(await wt.diff(info.path)).toEqual({ patch: "", truncated: false });
    writeFileSync(join(info.path, "a.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(info.path, "new.txt"), "fresh\n");
    const d = await wt.diff(info.path);
    expect(d.patch).toContain("-two");
    expect(d.patch).toContain("+TWO");
    expect(d.patch).toMatch(/new file mode[\s\S]*\+fresh/);
    expect((await wt.status(info.path)).files.find((f) => f.path === "new.txt")?.code).toBe("??");
  });

  it("cuts output beyond maxBytes and says so", async () => {
    const info = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    writeFileSync(join(info.path, "big.txt"), "x".repeat(5000));
    const d = await wt.diff(info.path, { maxBytes: 300 });
    expect(d.truncated).toBe(true);
    expect(d.patch.length).toBe(300);
  });
});

describe("remove / prune", () => {
  it("removes a clean worktree", async () => {
    const info = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    await wt.remove(info.path);
    expect(existsSync(info.path)).toBe(false);
    expect((await wt.list()).some((w) => samePath(w.path, info.path))).toBe(false);
  });

  it("refuses a dirty worktree unless forced, and keeps the work", async () => {
    const info = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    writeFileSync(join(info.path, "a.txt"), "precious\n");
    await expect(wt.remove(info.path)).rejects.toThrow(WorktreeDirtyError);
    expect(readFileSync(join(info.path, "a.txt"), "utf8")).toBe("precious\n");
    await wt.remove(info.path, { force: true });
    expect(existsSync(info.path)).toBe(false);
  });

  it("can delete the branch too, only when asked", async () => {
    const info = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    await wt.remove(info.path);
    expect(git(repo, "branch", "--list", info.branch)).not.toBe("");
    const second = await wt.create({ workflowId: "wf_1", taskId: "task_b" });
    await wt.remove(second.path, { deleteBranch: true });
    expect(git(repo, "branch", "--list", second.branch)).toBe("");
  });

  it("flags a worktree deleted behind git's back as prunable, and prune clears it", async () => {
    const info = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    rmSync(info.path, { recursive: true, force: true });
    const entry = (await wt.list()).find((w) => samePath(w.path, info.path));
    expect(entry?.prunable).toBe(true);
    await wt.prune();
    expect((await wt.list()).some((w) => samePath(w.path, info.path))).toBe(false);
  });
});

describe("checkMerge", () => {
  const commitIn = (path: string, file: string, text: string) => {
    writeFileSync(join(path, file), text);
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", `edit ${file}`);
  };

  it("is clean for disjoint edits", async () => {
    const a = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    commitIn(a.path, "only-a.txt", "a\n");
    expect(await wt.checkMerge(a.branch, "main")).toEqual({ clean: true, conflicts: [] });
  });

  it("names the conflicting files when two branches change the same lines", async () => {
    const a = await wt.create({ workflowId: "wf_1", taskId: "task_a" });
    const b = await wt.create({ workflowId: "wf_1", taskId: "task_b" });
    commitIn(a.path, "a.txt", "A\ntwo\nthree\n");
    commitIn(b.path, "a.txt", "B\ntwo\nthree\n");
    expect(await wt.checkMerge(b.branch, a.branch)).toEqual({ clean: false, conflicts: ["a.txt"] });
    // Checking never touches either tree.
    expect(await wt.status(a.path)).toEqual({ dirty: false, files: [] });
  });
});
