import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { ArtifactRegistry } from "./artifacts.js";

let dir: string;
let db: StudioDb;
let repo: Repo;
let task: string;
let wtPath: string;
let reg: ArtifactRegistry;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-art-"));
  db = openDatabase(join(dir, "test.db"));
  runMigrations(db);
  repo = new Repo(db);
  const wf = repo.createWorkflow(repo.createProject("demo", "/p"));
  task = repo.createTask(wf, "claude");
  wtPath = join(dir, "wt");
  mkdirSync(wtPath);
  repo.createWorktree({ workflowId: wf, taskId: task, path: wtPath, branch: "b", baseRef: "HEAD" });
  reg = new ArtifactRegistry(repo, {
    diff: async (p) => ({ patch: `diff of ${p}`, truncated: false }),
  });
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ArtifactRegistry.verify", () => {
  it("reports ok, changed and missing files", () => {
    writeFileSync(join(wtPath, "a.txt"), "one");
    writeFileSync(join(wtPath, "b.txt"), "two");
    repo.registerArtifact(task, "a.txt", sha("one"));
    repo.registerArtifact(task, "b.txt", sha("two"));
    repo.registerArtifact(task, "c.txt", sha("three"));
    writeFileSync(join(wtPath, "b.txt"), "TWO");
    const r = reg.verify(task);
    expect(r.map((c) => [c.path, c.status])).toEqual([
      ["a.txt", "ok"],
      ["b.txt", "changed"],
      ["c.txt", "missing"],
    ]);
    expect(r[1]?.actualSha256).toBe(sha("TWO"));
  });

  it("never reads a registered path that escapes the worktree", () => {
    writeFileSync(join(dir, "secret.txt"), "s");
    repo.registerArtifact(task, "../secret.txt", sha("s"));
    repo.registerArtifact(task, join(dir, "secret.txt"), sha("s"));
    expect(reg.verify(task).map((c) => c.status)).toEqual(["missing", "missing"]);
  });

  it("fails for a task without a worktree", () => {
    expect(() => reg.verify("task_none")).toThrow(/no worktree/);
  });
});

describe("ArtifactRegistry.diff", () => {
  it("diffs the task's worktree", async () => {
    expect((await reg.diff(task)).patch).toBe(`diff of ${wtPath}`);
  });
});
