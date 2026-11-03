import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  AdapterRegistry,
  StubAdapter,
  type AgentAdapter,
  type AgentTask,
} from "@agent-studio/agent-core";
import type { AgentCapability, AgentEvent } from "@agent-studio/contracts";
import { GitWorktrees } from "@agent-studio/git-worktrees";
import { createLogger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { Orchestrator, Scheduler, TaskRunner } from "./index.js";

/** Blocks each task until `release(taskId)`; records cwd; can dirty its cwd. */
class GateAdapter implements AgentAdapter {
  readonly id = "gate";
  readonly cwds = new Map<string, string>();
  readonly started: string[] = [];
  private gates = new Map<string, () => void>();
  dirty = false;
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapability[]> {
    return ["streaming"];
  }
  async cancel() {}
  release(taskId: string) {
    this.gates.get(taskId)?.();
  }
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    this.cwds.set(task.id, task.cwd);
    this.started.push(task.id);
    if (this.dirty) writeFileSync(join(task.cwd, "wip.txt"), "x");
    await new Promise<void>((resolve) => {
      this.gates.set(task.id, resolve);
      task.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (task.signal.aborted) {
      yield { type: "error", message: "cancelled" };
      return;
    }
    yield { type: "completed" };
  }
}

let dir: string;
let db: StudioDb;
let repo: Repo;
let gate: GateAdapter;
let runner: TaskRunner;
let wf: string;
let gitRoot: string;

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

function build(opts: { leaseMs?: number; heartbeatMs?: number } = {}) {
  const registry = new AdapterRegistry();
  registry.register(new StubAdapter());
  registry.register(gate);
  const log = createLogger({
    name: "t",
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const orchestrator = new Orchestrator(registry, repo, log);
  const scheduler = new Scheduler(repo, { leaseMs: opts.leaseMs ?? 60_000 });
  runner = new TaskRunner({
    orchestrator,
    repo,
    scheduler,
    registry,
    log,
    worktreesFor: (root) => new GitWorktrees({ repoRoot: root }),
    ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}),
  });
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-studio-runner-")));
  db = openDatabase(join(dir, "r.db"));
  runMigrations(db);
  repo = new Repo(db);
  gate = new GateAdapter();
  gitRoot = join(dir, "proj");
  mkdirSync(gitRoot);
  execFileSync("git", ["init", "-q", "-b", "main", gitRoot]);
  writeFileSync(join(gitRoot, "a.txt"), "base\n");
  git(gitRoot, "add", "a.txt");
  git(gitRoot, "commit", "-m", "base");
  wf = repo.createWorkflow(repo.createProject("p", gitRoot));
  build();
});
afterEach(async () => {
  for (const id of gate.started) gate.release(id);
  await runner.settle();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe("TaskRunner", () => {
  it("persists the request as message 0 and runs a queued task to completion", async () => {
    const id = runner.submit({ workflowId: wf, agentId: "stub", prompt: "hi" });
    expect(repo.getTaskState(id)).toBe("queued");
    await runner.pump();
    await runner.settle();
    expect(repo.getTaskState(id)).toBe("completed");
    const msgs = repo.listMessages(id);
    expect(msgs.map((m) => m.sequence)).toEqual(msgs.map((_, i) => i));
    expect(msgs[0]).toMatchObject({ type: "task.request", payload: { prompt: "hi" } });
    expect(msgs[1]?.type).toBe("task.accepted");
  });

  it("runs dependents only after the dependency completed", async () => {
    const a = runner.submit({ workflowId: wf, agentId: "gate", prompt: "a" });
    const b = runner.submit({ workflowId: wf, agentId: "gate", prompt: "b", dependsOn: [a] });
    await runner.pump();
    await until(() => gate.started.includes(a));
    expect(gate.started).toEqual([a]);
    gate.release(a);
    await runner.settle();
    await runner.pump();
    await until(() => gate.started.includes(b));
    gate.release(b);
    await runner.settle();
    expect(repo.getTaskState(b)).toBe("completed");
  });

  it("never runs more than maxConcurrent (2) tasks at once", async () => {
    const ids = [1, 2, 3].map((n) =>
      runner.submit({ workflowId: wf, agentId: "gate", prompt: `${n}` }),
    );
    await runner.pump();
    await until(() => gate.started.length === 2);
    expect(repo.getTaskState(ids[2]!)).toBe("queued");
    const first = gate.started[0]!;
    gate.release(first);
    await until(() => repo.getTaskState(first) === "completed");
    await runner.pump();
    await until(() => gate.started.length === 3);
  });

  it("isolated tasks run in separate registered worktrees, not in the project root", async () => {
    const a = runner.submit({ workflowId: wf, agentId: "gate", prompt: "a", isolate: true });
    const b = runner.submit({ workflowId: wf, agentId: "gate", prompt: "b", isolate: true });
    await runner.pump();
    await until(() => gate.started.length === 2);
    const [ca, cb] = [gate.cwds.get(a)!, gate.cwds.get(b)!];
    expect(ca).not.toBe(cb);
    for (const c of [ca, cb]) {
      expect(c).not.toBe(gitRoot);
      expect(c.replaceAll("\\", "/")).toContain(".git/agent-studio/worktrees/");
    }
    expect(repo.getWorktree(a)).toMatchObject({ path: ca, state: "active" });
  });

  it("fails (and never runs the adapter) when isolation is requested outside a git repo", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const w2 = repo.createWorkflow(repo.createProject("q", plain));
    const id = runner.submit({ workflowId: w2, agentId: "gate", prompt: "x", isolate: true });
    await runner.pump();
    await runner.settle();
    expect(repo.getTaskState(id)).toBe("failed");
    expect(gate.started).toEqual([]);
    expect(repo.listMessages(id).at(-1)?.type).toBe("task.failed");
  });

  it("cancels a queued task without running it", async () => {
    const id = runner.submit({ workflowId: wf, agentId: "gate", prompt: "x" });
    expect(runner.cancel(id)).toBe("cancelled");
    await runner.pump();
    expect(gate.started).toEqual([]);
  });

  it("cancelling a running isolated task removes its clean worktree", async () => {
    const id = runner.submit({ workflowId: wf, agentId: "gate", prompt: "x", isolate: true });
    await runner.pump();
    await until(() => gate.started.includes(id));
    const path = gate.cwds.get(id)!;
    runner.cancel(id);
    await runner.settle();
    expect(repo.getTaskState(id)).toBe("cancelled");
    expect(existsSync(path)).toBe(false);
    expect(repo.getWorktree(id)?.state).toBe("removed");
  });

  it("keeps a dirty worktree after cancel so partial work is not destroyed", async () => {
    gate.dirty = true;
    const id = runner.submit({ workflowId: wf, agentId: "gate", prompt: "x", isolate: true });
    await runner.pump();
    await until(() => gate.started.includes(id));
    runner.cancel(id);
    await runner.settle();
    expect(repo.getTaskState(id)).toBe("cancelled");
    expect(existsSync(gate.cwds.get(id)!)).toBe(true);
    expect(repo.getWorktree(id)?.state).toBe("active");
  });

  it("heartbeats keep a long task from losing its lease", async () => {
    build({ leaseMs: 60, heartbeatMs: 10 });
    const id = runner.submit({ workflowId: wf, agentId: "gate", prompt: "x" });
    await runner.pump();
    await until(() => gate.started.includes(id));
    await new Promise((r) => setTimeout(r, 200)); // more than 3 leases
    const t = await runner.pump();
    expect(t.expired).toEqual([]);
    expect(repo.getTaskState(id)).toBe("running");
  });
});
