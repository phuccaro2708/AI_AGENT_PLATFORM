import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorktrees, UntrustedGitConfigError } from "./git-worktrees.js";

/**
 * T19 regression: a repo whose own `.git/config` wires hooks, `core.fsmonitor`, a diff textconv/external
 * driver and a filter driver. Every payload only appends a line to a file under `marks/` in the scratch dir.
 */
let root: string;
let repo: string;
let marks: string;
const fwd = (p: string) => p.split("\\").join("/");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fired = () => readdirSync(marks).sort();
const reset = () => {
  for (const f of readdirSync(marks)) rmSync(join(marks, f));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "as-t19-"));
  repo = join(root, "repo");
  marks = join(root, "marks");
  const hooks = join(root, "hooks");
  mkdirSync(marks);
  mkdirSync(hooks);
  git(root, "init", "-q", "-b", "main", "repo");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil diff=evil\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  // Armed only after the clean setup commit.
  const m = fwd(marks);
  for (const h of ["post-checkout", "reference-transaction", "post-index-change", "pre-commit"]) {
    // The executable bit matters on POSIX: git silently skips a hook that is not executable, which would make
    // the control and every "never runs" check below pass for the wrong reason.
    writeFileSync(join(hooks, h), `#!/bin/sh\necho ran >> "${m}/hook-${h}"\nexit 0\n`, {
      mode: 0o755,
    });
  }
  git(repo, "config", "core.hooksPath", fwd(hooks));
  git(repo, "config", "core.fsmonitor", `echo ran >> "${m}/fsmonitor"; true`);
  git(repo, "config", "diff.external", `echo ran >> "${m}/diff-external"; true`);
  git(repo, "config", "diff.evil.textconv", `sh -c 'echo ran >> "${m}/textconv"; cat "$0"'`);
  git(repo, "config", "filter.evil.smudge", `echo ran >> "${m}/filter-smudge"; cat`);
  git(repo, "config", "filter.evil.clean", `echo ran >> "${m}/filter-clean"; cat`);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("hostile repo config (T19)", () => {
  it("control: the same config does fire hooks and fsmonitor under plain git", () => {
    git(repo, "worktree", "add", "-q", "-b", "ctl", join(root, "ctl"));
    git(join(root, "ctl"), "status", "--porcelain");
    expect(fired()).toEqual(expect.arrayContaining(["fsmonitor", "hook-post-checkout"]));
  });

  it("hooks, fsmonitor, textconv and external diff never run through GitWorktrees", async () => {
    const wt = new GitWorktrees({
      repoRoot: repo,
      baseDir: join(root, "wt"),
      allowFilters: ["evil"], // isolate the non-filter vectors
    });
    reset();
    const info = await wt.create({ workflowId: "wf_1", taskId: "task_1" });
    await wt.list();
    writeFileSync(join(info.path, "a.txt"), "two\n");
    writeFileSync(join(info.path, "new.txt"), "new\n");
    await wt.status(info.path);
    await wt.diff(info.path);
    await wt.checkMerge(info.branch, "main");
    await wt.remove(info.path, { force: true, deleteBranch: true });
    await wt.prune();
    const names = fired().filter((n) => !n.startsWith("filter-"));
    expect(names).toEqual([]);
  });

  it("refuses repo-defined filter drivers by default, before any command runs", async () => {
    const wt = new GitWorktrees({ repoRoot: repo, baseDir: join(root, "wt") });
    reset();
    await expect(wt.create({ workflowId: "wf_1", taskId: "task_1" })).rejects.toThrow(
      UntrustedGitConfigError,
    );
    expect(existsSync(join(root, "wt"))).toBe(false);
    expect(fired()).toEqual([]);
  });

  it("allowFilters lets a trusted driver through", async () => {
    const wt = new GitWorktrees({
      repoRoot: repo,
      baseDir: join(root, "wt"),
      allowFilters: ["evil"],
    });
    const info = await wt.create({ workflowId: "wf_1", taskId: "task_1" });
    expect(existsSync(join(info.path, "a.txt"))).toBe(true);
  });
});
