import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { Repo } from "@agent-studio/storage";
import { ApprovalService } from "./approvals.js";
import { SidecarService } from "./sidecar.js";

/** Writes a file when it has write access; otherwise only reads and approves. */
class Fake implements AgentAdapter {
  tasks: AgentTask[] = [];
  constructor(readonly id: string) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    this.tasks.push(task);
    if (task.permissions === "workspace-write") {
      writeFileSync(join(task.cwd, "feature.txt"), "done\n");
      yield { type: "text", content: "wrote feature.txt" };
    } else {
      yield { type: "text", content: '{"verdict":"approve","comments":[]}' };
    }
    yield { type: "completed" };
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let dir: string;
let projectRoot: string;
let svc: SidecarService;
let impl: Fake;
let rev: Fake;
let n = 0;

const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-pr-"));
  projectRoot = join(dir, "project");
  mkdirSync(projectRoot);
  git(projectRoot, "init", "-q", "-b", "main");
  git(projectRoot, "config", "user.email", "t@example.com");
  git(projectRoot, "config", "user.name", "t");
  git(projectRoot, "config", "core.autocrlf", "false");
  writeFileSync(join(projectRoot, "README.md"), "hi\n");
  git(projectRoot, "add", ".");
  git(projectRoot, "commit", "-q", "-m", "init");
  impl = new Fake("impl");
  rev = new Fake("rev");
  svc = new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      extraAdapters: [impl, rev],
      worktreesDir: join(dir, "wt"),
      schedulerIntervalMs: 20,
    },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitForWorkflow(workflowId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await call<{ workflowState: string }>("tasks.list", { workflowId });
    if (r.workflowState === "completed" || r.workflowState === "failed") return r.workflowState;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("workflow did not settle");
}

describe("Peer Review through the sidecar (real git worktree, fake agents)", () => {
  it("runs implement -> review and exposes tasks, context, artifacts, diff and worktrees", async () => {
    const { projectId } = await call<{ projectId: string }>("projects.create", {
      name: "demo",
      rootPath: projectRoot,
    });
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    await call("workflows.startPeerReview", {
      workflowId,
      implementerAgent: "impl",
      reviewerAgent: "rev",
      goal: "add feature.txt",
    });
    expect(await waitForWorkflow(workflowId)).toBe("completed");

    const { tasks } = await call<{ tasks: { id: string; agentId: string; state: string }[] }>(
      "tasks.list",
      { workflowId },
    );
    expect(tasks.map((t) => [t.agentId, t.state])).toEqual([
      ["impl", "completed"],
      ["rev", "completed"],
    ]);
    expect(impl.tasks[0]?.cwd).toBe(rev.tasks[0]?.cwd);
    expect(impl.tasks[0]?.cwd.startsWith(join(dir, "wt"))).toBe(true);
    // The main checkout is untouched: the work happened in the worktree.
    expect(git(projectRoot, "status", "--porcelain")).toBe("");

    const implId = tasks[0]!.id;
    const { artifacts } = await call<{ artifacts: { path: string; status: string }[] }>(
      "artifacts.list",
      { taskId: implId },
    );
    expect(artifacts).toMatchObject([{ path: "feature.txt", status: "ok" }]);
    const diff = await call<{ patch: string }>("artifacts.diff", { taskId: implId });
    expect(diff.patch).toContain("+done");

    const { worktrees } = await call<{ worktrees: { state: string }[] }>("worktrees.list", {
      workflowId,
    });
    expect(worktrees).toMatchObject([{ state: "active" }]);
    const { items } = await call<{ items: { kind: string }[] }>("context.list", { workflowId });
    expect(items.map((i) => i.kind)).toContain("artifact");
    const { roles } = await call<{ roles: { name: string }[] }>("roles.list", { workflowId });
    expect(roles.map((r) => r.name).sort()).toEqual(["implementer", "reviewer"]);
  });

  it("refuses unknown agents and a second start of the same workflow", async () => {
    const { projectId } = await call<{ projectId: string }>("projects.create", {
      name: "demo",
      rootPath: projectRoot,
    });
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    const params = { workflowId, implementerAgent: "impl", reviewerAgent: "rev", goal: "g" };
    await expect(
      call("workflows.startPeerReview", { ...params, reviewerAgent: "ghost" }),
    ).rejects.toThrow(/Unknown agent/);
    await call("workflows.startPeerReview", params);
    await expect(call("workflows.startPeerReview", params)).rejects.toThrow(
      /Illegal workflow transition/,
    );
    await waitForWorkflow(workflowId);
  });

  it("fails the task, not the app, when the project is not a git repository", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const { projectId } = await call<{ projectId: string }>("projects.create", {
      name: "plain",
      rootPath: plain,
    });
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    await call("workflows.startPeerReview", {
      workflowId,
      implementerAgent: "impl",
      reviewerAgent: "rev",
      goal: "g",
    });
    expect(await waitForWorkflow(workflowId)).toBe("failed");
    expect(impl.tasks).toHaveLength(0); // nothing ran without a workspace
  });
});

describe("approvals through the sidecar", () => {
  it("lists, resolves once and refuses a second answer", async () => {
    const repo = new Repo(svc.db);
    const wf = repo.createWorkflow(repo.createProject("p", projectRoot));
    const task = repo.createTask(wf, "impl");
    repo.setTaskState(task, "running");
    const id = new ApprovalService({ repo }).request(task, "merge it");

    const listed = await call<{ approvals: { id: string; state: string }[] }>("approvals.list", {
      state: "pending",
    });
    expect(listed.approvals.map((a) => a.id)).toEqual([id]);
    await call("approvals.resolve", { approvalId: id, decision: "approved" });
    expect(repo.getTaskState(task)).toBe("running");
    await expect(call("approvals.resolve", { approvalId: id, decision: "denied" })).rejects.toThrow(
      /not pending/,
    );
  });
});
