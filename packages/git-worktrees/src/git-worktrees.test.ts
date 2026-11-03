import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorktrees, branchNameFor } from "./index.js";

let root: string;
let repo: string;
let gw: GitWorktrees;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
const commitFile = (cwd: string, name: string, content: string) => {
  writeFileSync(join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", `add ${name}`);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-studio-wt-")));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commitFile(repo, "a.txt", "base\n");
  gw = new GitWorktrees({ repoRoot: repo });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("branchNameFor", () => {
  it("accepts safe task ids and rejects anything that could inject refs/options", () => {
    expect(branchNameFor("task_01ABC")).toBe("agent/task_01ABC");
    for (const bad of ["-x", "a b", "a..b", "a/../b", "", "x;rm", "a~1"])
      expect(() => branchNameFor(bad)).toThrow();
  });
});

describe("GitWorktrees", () => {
  it("creates a worktree on its own branch inside .git, leaving the repo status clean", async () => {
    const w = await gw.create({ taskId: "t1" });
    expect(w.branch).toBe("agent/t1");
    expect(existsSync(join(w.path, "a.txt"))).toBe(true);
    expect(w.path.replaceAll("\\", "/")).toContain("/.git/agent-studio/worktrees/t1");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(w.baseSha).toBe(git(repo, "rev-parse", "main"));
  });

  it("refuses a duplicate task and a missing base ref", async () => {
    await gw.create({ taskId: "t1" });
    await expect(gw.create({ taskId: "t1" })).rejects.toThrow(/exists/i);
    await expect(gw.create({ taskId: "t2", baseRef: "nope" })).rejects.toThrow(/base/i);
    await expect(gw.create({ taskId: "t3", baseRef: "--upload-pack=x" })).rejects.toThrow();
  });

  it("two worktrees created concurrently do not overwrite each other", async () => {
    const [a, b] = await Promise.all([gw.create({ taskId: "ta" }), gw.create({ taskId: "tb" })]);
    writeFileSync(join(a.path, "a.txt"), "from a\n");
    writeFileSync(join(b.path, "a.txt"), "from b\n");
    expect((await gw.status(a.path)).dirty).toBe(true);
    expect(git(a.path, "diff", "--name-only")).toBe("a.txt");
    expect(git(repo, "show", "HEAD:a.txt")).toBe("base");
    expect((await gw.list()).map((w) => w.branch).sort()).toEqual(["agent/ta", "agent/tb"]);
  });

  it("status reports dirty files, including untracked", async () => {
    const w = await gw.create({ taskId: "t1" });
    expect(await gw.status(w.path)).toEqual({ dirty: false, files: [] });
    writeFileSync(join(w.path, "new.txt"), "x");
    expect(await gw.status(w.path)).toEqual({ dirty: true, files: ["new.txt"] });
  });

  it("detects merge conflicts without touching any working tree", async () => {
    const w1 = await gw.create({ taskId: "t1" });
    const w2 = await gw.create({ taskId: "t2" });
    commitFile(w1.path, "a.txt", "one\n");
    commitFile(w2.path, "a.txt", "two\n");
    const before = git(repo, "status", "--porcelain");
    expect(await gw.detectConflicts(w1.branch, w2.branch)).toEqual({ conflicts: ["a.txt"] });
    expect(git(repo, "status", "--porcelain")).toBe(before);
    commitFile(w2.path, "b.txt", "ok\n");
    git(w2.path, "reset", "--hard", "HEAD~2"); // back to base
    commitFile(w2.path, "c.txt", "disjoint\n");
    expect(await gw.detectConflicts(w1.branch, w2.branch)).toEqual({ conflicts: [] });
  });

  it("remove refuses a dirty worktree unless forced, and keeps the branch (commits are not lost)", async () => {
    const w = await gw.create({ taskId: "t1" });
    commitFile(w.path, "work.txt", "done\n");
    writeFileSync(join(w.path, "wip.txt"), "x");
    await expect(gw.remove({ taskId: "t1" })).rejects.toThrow(/uncommitted|dirty/i);
    expect(existsSync(w.path)).toBe(true);
    await gw.remove({ taskId: "t1", force: true });
    expect(existsSync(w.path)).toBe(false);
    expect(git(repo, "branch", "--list", "agent/t1")).toContain("agent/t1");
    expect(await gw.list()).toEqual([]);
  });

  it("remove with deleteBranch drops the branch; removing an unknown task is a no-op", async () => {
    await gw.create({ taskId: "t1" });
    await gw.remove({ taskId: "t1", deleteBranch: true });
    expect(git(repo, "branch", "--list", "agent/t1")).toBe("");
    await expect(gw.remove({ taskId: "ghost" })).resolves.toBeUndefined();
  });
});

describe("GitWorktrees.commitAll / diffStat", () => {
  it("checkpoints tracked, modified and untracked files; no-op when clean", async () => {
    const w = await gw.create({ taskId: "t1" });
    expect(await gw.commitAll(w.path, "noop")).toMatchObject({ committed: false });
    writeFileSync(join(w.path, "a.txt"), "changed\n");
    writeFileSync(join(w.path, "new.txt"), "n\n");
    const r = await gw.commitAll(w.path, "checkpoint");
    expect(r.committed).toBe(true);
    expect(r.sha).toBe(git(w.path, "rev-parse", "HEAD"));
    expect((await gw.status(w.path)).dirty).toBe(false);
    expect(git(w.path, "log", "-1", "--format=%an <%ae>")).toBe(
      "Agent Studio <agent-studio@localhost>",
    );
    const stat = await gw.diffStat(w.baseSha, w.branch);
    expect(stat).toContain("a.txt");
    expect(stat).toContain("new.txt");
    await expect(gw.diffStat("--output=x", w.branch)).rejects.toThrow();
  });
});

describe("GitWorktrees.changedFiles", () => {
  it("lists added, modified and deleted files of a branch", async () => {
    const w = await gw.create({ taskId: "t1" });
    writeFileSync(join(w.path, "a.txt"), "changed\n");
    writeFileSync(join(w.path, "sub name.txt"), "n\n");
    await gw.commitAll(w.path, "c1");
    rmSync(join(w.path, "sub name.txt"));
    git(w.path, "rm", "-q", "a.txt");
    await gw.commitAll(w.path, "c2");
    expect(await gw.changedFiles(w.baseSha, w.branch)).toEqual([{ path: "a.txt", deleted: true }]);
    await expect(gw.changedFiles("--x", w.branch)).rejects.toThrow();
  });
});
