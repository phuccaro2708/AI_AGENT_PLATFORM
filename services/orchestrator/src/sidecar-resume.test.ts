import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

/** Writes feature.txt as the implementer; a reviewer approves. `hang` simulates a process that dies mid-run. */
class Fake implements AgentAdapter {
  runs = 0;
  constructor(
    readonly id: string,
    private readonly hang = false,
  ) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    this.runs++;
    if (task.permissions === "workspace-write") {
      writeFileSync(join(task.cwd, "feature.txt"), "done\n");
      yield { type: "text", content: "wrote feature.txt" };
      if (this.hang) await new Promise<void>(() => undefined); // never settles: the "process" is killed
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
const sink = () => new Writable({ write: (_c, _e, cb) => cb() });

const open = (adapters: Fake[]) =>
  new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      extraAdapters: adapters,
      worktreesDir: join(dir, "wt"),
      schedulerIntervalMs: 20,
    },
    createLogger({ name: "t", destination: sink() }),
  );

const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
};

interface Listing {
  workflowState: string;
  tasks: { id: string; state: string; agentId: string }[];
}
const list = (workflowId: string) => call<Listing>("tasks.list", { workflowId });

async function until(workflowId: string, ok: (l: Listing) => boolean): Promise<Listing> {
  for (let i = 0; i < 150; i++) {
    const l = await list(workflowId);
    if (ok(l)) return l;
    await new Promise((r) => setTimeout(r, 20));
  }
  const ctx = await call("context.list", { workflowId });
  throw new Error(`timeout: ${JSON.stringify(await list(workflowId))} ${JSON.stringify(ctx)}`);
}

/** Starts a Peer Review whose implementer "dies" mid-run, then restarts on the same database. */
async function crashedWorkflow(): Promise<{ workflowId: string; implementerTask: string }> {
  const hanging = new Fake("impl", true);
  svc = open([hanging, new Fake("rev")]);
  const { projectId } = await call<{ projectId: string }>("projects.create", {
    name: "p",
    rootPath: projectRoot,
  });
  const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
  await call("workflows.startPeerReview", {
    workflowId,
    implementerAgent: "impl",
    reviewerAgent: "rev",
    goal: "add feature.txt",
  });
  // The adapter has started, so the worktree exists and the file was written.
  while (hanging.runs === 0) await new Promise((r) => setTimeout(r, 10));
  const running = await list(workflowId);
  svc.close(); // the row stays `running`: nothing ever settled it
  impl = new Fake("impl");
  rev = new Fake("rev");
  svc = open([impl, rev]);
  return { workflowId, implementerTask: running.tasks[0]!.id };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-resume-"));
  projectRoot = join(dir, "project");
  mkdirSync(projectRoot);
  git(projectRoot, "init", "-q", "-b", "main");
  git(projectRoot, "config", "user.email", "t@example.com");
  git(projectRoot, "config", "user.name", "t");
  git(projectRoot, "config", "core.autocrlf", "false");
  writeFileSync(join(projectRoot, "README.md"), "hi\n");
  git(projectRoot, "add", ".");
  git(projectRoot, "commit", "-q", "-m", "init");
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Peer Review after a restart", () => {
  it("waits for a person: the interrupted task is needs_reconciliation, nothing is re-run", async () => {
    const { workflowId } = await crashedWorkflow();
    // Wait for the restart to mark the task, then give the scheduler a few ticks to (wrongly) re-run it.
    await until(workflowId, (x) => x.tasks.some((t) => t.state === "needs_reconciliation"));
    await new Promise((r) => setTimeout(r, 100));
    const l = await list(workflowId);
    expect(l.workflowState).toBe("running");
    expect(l.tasks.map((t) => t.state)).toEqual(["needs_reconciliation"]);
    expect(impl.runs + rev.runs).toBe(0);
  });

  it("`completed` hands over to the reviewer and the workflow completes", async () => {
    const { workflowId, implementerTask } = await crashedWorkflow();
    await call("tasks.resolveReconciliation", {
      taskId: implementerTask,
      decision: "completed",
      note: "feature.txt is in the worktree",
    });
    const l = await until(workflowId, (x) => x.workflowState === "completed");
    expect(l.tasks.map((t) => t.state)).toEqual(["completed", "completed"]);
    expect(l.tasks[1]!.agentId).toBe("rev");
    expect(impl.runs).toBe(0); // the implementer was not run again
    expect(rev.runs).toBe(1);
  });

  it("`failed` fails the workflow without starting a reviewer", async () => {
    const { workflowId, implementerTask } = await crashedWorkflow();
    await call("tasks.resolveReconciliation", {
      taskId: implementerTask,
      decision: "failed",
      note: "nothing usable was written",
    });
    const l = await until(workflowId, (x) => x.workflowState === "failed");
    expect(l.tasks).toHaveLength(1);
    expect(rev.runs).toBe(0);
  });

  it("`requeue` re-runs the implementer in the same worktree, then the review follows", async () => {
    const { workflowId, implementerTask } = await crashedWorkflow();
    await call("tasks.resolveReconciliation", {
      taskId: implementerTask,
      decision: "requeue",
      note: "checked: safe to run again",
    });
    const l = await until(workflowId, (x) => x.workflowState === "completed");
    expect(l.tasks.map((t) => t.state)).toEqual(["completed", "completed"]);
    expect(impl.runs).toBe(1);
    const wts = await call<{ worktrees: { state: string }[] }>("worktrees.list", { workflowId });
    expect(wts.worktrees).toHaveLength(1);
  });
});
