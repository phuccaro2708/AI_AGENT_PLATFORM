import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent } from "@agent-studio/contracts";
import { AdapterRegistry, type AgentAdapter, type AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { ContextBoard } from "./context-board.js";
import { Orchestrator } from "./orchestrator.js";
import { Scheduler } from "./scheduler.js";
import { PeerReviewEngine, type Workspaces } from "./workflow-engine.js";

/** An agent whose behaviour per call is scripted; records what it was given. */
class Scripted implements AgentAdapter {
  tasks: AgentTask[] = [];
  constructor(
    readonly id: string,
    private readonly script: (task: AgentTask, call: number) => AgentEvent[],
  ) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    this.tasks.push(task);
    for (const ev of this.script(task, this.tasks.length)) yield ev;
  }
}

const verdict = (v: "approve" | "request_changes", comments: string[] = []): AgentEvent[] => [
  { type: "text", content: "looking at it" },
  { type: "text", content: JSON.stringify({ verdict: v, comments }) },
  { type: "completed" },
];

let dir: string;
let db: StudioDb;
let repo: Repo;
let wf: string;
let workspaceRoot: string;
let impl: Scripted;
let rev: Scripted;
let engine: PeerReviewEngine;
let scheduler: Scheduler;
/** Paths the fake git reports as deleted tracked files (code " D"); nothing exists on disk for them. */
let deletedTracked: string[] = [];

/** Stands in for GitWorktrees: a plain directory per task; every file in it counts as changed. */
const workspaces: Workspaces = {
  async create(_workflowId, taskId) {
    const path = join(workspaceRoot, taskId);
    mkdirSync(path, { recursive: true });
    return { path, branch: `agent-studio/test/${taskId}`, baseRef: "HEAD" };
  },
  async status(path) {
    const files = existsSync(path) ? readdirSync(path).map((p) => ({ path: p, code: "??" })) : [];
    for (const p of deletedTracked) files.push({ path: p, code: " D" });
    return { dirty: files.length > 0, files };
  },
};

type Script = ConstructorParameters<typeof Scripted>[1];

function setup(implScript: Script, revScript: Script, maxRounds = 2) {
  impl = new Scripted("impl", implScript);
  rev = new Scripted("rev", revScript);
  const registry = new AdapterRegistry();
  registry.register(impl);
  registry.register(rev);
  const board = new ContextBoard(repo);
  const hooksRef: { engine?: PeerReviewEngine } = {};
  const orchestrator = new Orchestrator(
    registry,
    repo,
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
    { resolveCwd: (ctx) => hooksRef.engine!.resolveCwd(ctx) },
  );
  engine = new PeerReviewEngine({ repo, orchestrator, board, workspaces, maxRounds });
  hooksRef.engine = engine;
  scheduler = new Scheduler({
    repo,
    orchestrator,
    onSettled: (id, result) => engine.onSettled(id, result),
  });
  engine.defineRoles(wf, { implementerAgent: "impl", reviewerAgent: "rev" });
}

const writeFile = (task: AgentTask, name: string, body: string) =>
  writeFileSync(join(task.cwd, name), body);

async function drive() {
  for (let i = 0; i < 20; i++) {
    const state = repo.getWorkflowState(wf);
    if (state === "completed" || state === "failed") return;
    await scheduler.tick();
    await scheduler.idle();
  }
  throw new Error("workflow did not settle");
}

beforeEach(() => {
  deletedTracked = [];
  dir = mkdtempSync(join(tmpdir(), "agent-studio-wfe-"));
  workspaceRoot = join(dir, "wt");
  db = openDatabase(join(dir, "test.db"));
  runMigrations(db);
  repo = new Repo(db);
  wf = repo.createWorkflow(repo.createProject("demo", join(dir, "project")));
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const implOk = (task: AgentTask): AgentEvent[] => {
  writeFile(task, "out.txt", "hello");
  return [{ type: "text", content: "SECRET-IMPLEMENTER-CHATTER" }, { type: "completed" }];
};

describe("PeerReviewEngine", () => {
  it("a custom maxRounds survives a restart: a fresh engine with another default still uses the stored limit", async () => {
    setup(implOk, () => verdict("request_changes", ["again"]), 4);
    engine.start({ workflowId: wf, goal: "g", maxRounds: 1 });
    expect(repo.getWorkflowMaxRounds(wf)).toBe(1);
    await scheduler.tick(); // round 1 implementer only
    await scheduler.idle();
    expect(impl.tasks).toHaveLength(1);
    expect(rev.tasks).toHaveLength(0);

    // "Restart": new engine, scheduler and adapters over the same database; the in-memory steps are gone.
    setup(implOk, () => verdict("request_changes", ["again"]), 4);
    await engine.resume(wf);
    await drive();
    expect(rev.tasks).toHaveLength(1);
    expect(impl.tasks).toHaveLength(0); // limit 1 (stored), not the new default 4: no second round
    expect(repo.getWorkflowState(wf)).toBe("failed");
  });

  it("without a stored maxRounds the engine default applies", async () => {
    setup(implOk, () => verdict("request_changes", ["again"]), 3);
    engine.start({ workflowId: wf, goal: "g" });
    expect(repo.getWorkflowMaxRounds(wf)).toBeUndefined();
    await drive();
    expect(impl.tasks).toHaveLength(3);
  });

  it("runs implement then review: the reviewer sees only the goal and verified artifacts", async () => {
    setup(implOk, () => verdict("approve"));
    engine.start({ workflowId: wf, goal: "add out.txt" });
    await drive();

    expect(repo.getWorkflowState(wf)).toBe("completed");
    const implTask = impl.tasks[0]!;
    const revTask = rev.tasks[0]!;
    expect(implTask.permissions).toBe("workspace-write");
    expect(revTask.permissions).toBe("read-only");
    expect(implTask.cwd).toContain(workspaceRoot);
    expect(revTask.cwd).toBe(implTask.cwd); // reviews the implementer's worktree, does not copy it

    expect(revTask.prompt).toContain("add out.txt");
    expect(revTask.prompt).toContain("out.txt");
    expect(revTask.prompt).toMatch(/sha256 [0-9a-f]{64}/);
    expect(revTask.prompt).not.toContain("SECRET-IMPLEMENTER-CHATTER");

    const implId = repo.listWorktrees(wf)[0]!.taskId;
    expect(repo.listWorktrees(wf)).toHaveLength(1);
    expect(repo.listWorktrees(wf)[0]!.state).toBe("active");
    expect(repo.listArtifacts(implId).map((a) => a.path)).toEqual(["out.txt"]);

    const types = (id: string) => repo.listMessages(id).map((m) => m.type);
    expect(types(implId)).toContain("review.request");
    expect(types(findTask("rev"))).toContain("review.result");
  });

  it("sends the reviewer's comments back to the implementer for another round", async () => {
    let round = 0;
    setup(implOk, () =>
      ++round === 1 ? verdict("request_changes", ["rename the file"]) : verdict("approve"),
    );
    engine.start({ workflowId: wf, goal: "add out.txt" });
    await drive();

    expect(repo.getWorkflowState(wf)).toBe("completed");
    expect(impl.tasks).toHaveLength(2);
    expect(impl.tasks[1]!.prompt).toContain("rename the file");
    expect(impl.tasks[1]!.prompt).toMatch(/\[agent-reported\][^\n]*rename the file/);
    expect(impl.tasks[1]!.cwd).toBe(impl.tasks[0]!.cwd);
    expect(repo.listWorktrees(wf)).toHaveLength(1);
  });

  it("fails the workflow when the review rounds run out", async () => {
    setup(implOk, () => verdict("request_changes", ["still wrong"]), 2);
    engine.start({ workflowId: wf, goal: "g" });
    await drive();
    expect(repo.getWorkflowState(wf)).toBe("failed");
    expect(impl.tasks).toHaveLength(2);
    expect(rev.tasks).toHaveLength(2);
  });

  it("detects a read-only reviewer that changed the worktree and does not trust its verdict", async () => {
    setup(implOk, (task) => {
      writeFile(task, "sneaky.txt", "x");
      return verdict("approve");
    });
    engine.start({ workflowId: wf, goal: "g" });
    await drive();
    expect(repo.getWorkflowState(wf)).toBe("failed");
    const notes = repo.listContextItems(wf, ["decision"]);
    expect(
      notes.some((n) => n.source === "verified" && /read-only reviewer/i.test(n.content)),
    ).toBe(true);
  });

  it("detects a read-only reviewer that deleted a tracked file", async () => {
    setup(implOk, () => {
      deletedTracked = ["tracked.txt"]; // gone from disk: nothing to hash, only git sees it
      return verdict("approve");
    });
    engine.start({ workflowId: wf, goal: "g" });
    await drive();
    expect(repo.getWorkflowState(wf)).toBe("failed");
    const notes = repo.listContextItems(wf, ["decision"]);
    expect(notes.some((n) => /read-only reviewer/i.test(n.content))).toBe(true);
  });

  it("fails closed when the implementer leaves a symlink to a file outside the worktree", async () => {
    const outside = join(dir, "outside-secret.txt");
    writeFileSync(outside, "outside-secret");
    let linked = true;
    setup(
      (task) => {
        try {
          symlinkSync(outside, join(task.cwd, "leak.txt"), "file");
        } catch {
          linked = false; // no symlink privilege: this test cannot run here
        }
        return [{ type: "completed" }];
      },
      () => verdict("approve"),
    );
    engine.start({ workflowId: wf, goal: "g" });
    await drive();
    if (!linked) return;
    expect(repo.getWorkflowState(wf)).toBe("failed");
    expect(rev.tasks).toHaveLength(0); // never reviewed
    const implId = repo.listWorktrees(wf)[0]!.taskId;
    expect(repo.listArtifacts(implId)).toEqual([]); // the outside file is not registered/hashed as an artifact
    const notes = repo.listContextItems(wf, ["decision"]);
    expect(notes.some((n) => /outside the worktree/i.test(n.content))).toBe(true);
  });

  it("fails when the reviewer gives no valid verdict", async () => {
    setup(implOk, () => [{ type: "text", content: "LGTM" }, { type: "completed" }]);
    engine.start({ workflowId: wf, goal: "g" });
    await drive();
    expect(repo.getWorkflowState(wf)).toBe("failed");
  });

  it("does not start a review when the implementer fails", async () => {
    setup(
      () => [{ type: "error", message: "boom" }],
      () => verdict("approve"),
    );
    engine.start({ workflowId: wf, goal: "g" });
    await drive();
    expect(repo.getWorkflowState(wf)).toBe("failed");
    expect(rev.tasks).toHaveLength(0);
  });
});

function findTask(agentId: string): string {
  const row = db.$client
    .prepare("SELECT id FROM tasks WHERE agent_id = ? ORDER BY created_at LIMIT 1")
    .get(agentId) as { id: string };
  return row.id;
}
