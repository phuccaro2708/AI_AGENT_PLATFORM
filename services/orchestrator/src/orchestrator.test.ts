import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  AdapterRegistry,
  StubAdapter,
  type AgentAdapter,
  type AgentTask,
} from "@agent-studio/agent-core";
import type { AgentEvent } from "@agent-studio/contracts";
import { createLogger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { Orchestrator } from "./index.js";

let dir: string;
let db: StudioDb;
let repo: Repo;
let orch: Orchestrator;
let workflowId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-orch-"));
  db = openDatabase(join(dir, "o.db"));
  runMigrations(db);
  repo = new Repo(db);
  const registry = new AdapterRegistry();
  registry.register(new StubAdapter());
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  orch = new Orchestrator(registry, repo, createLogger({ name: "t", destination: sink }));
  workflowId = repo.createWorkflow(repo.createProject("p", "/p"));
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Orchestrator (stub end-to-end)", () => {
  it("runs a task, persists ordered messages, ends completed", async () => {
    const r = await orch.runTask({ workflowId, agentId: "stub", prompt: "hi", cwd: "/w" });
    expect(r.finalState).toBe("completed");
    expect(repo.getTaskState(r.taskId)).toBe("completed");
    const msgs = repo.listMessages(r.taskId);
    expect(msgs.map((m) => m.sequence)).toEqual(msgs.map((_, i) => i));
    expect(msgs[0]?.type).toBe("task.accepted");
    expect(msgs.at(-1)?.type).toBe("task.completed");
  });
  it("marks the task cancelled when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await orch.runTask({
      workflowId,
      agentId: "stub",
      prompt: "hi",
      cwd: "/w",
      signal: ac.signal,
    });
    expect(r.finalState).toBe("cancelled");
    expect(repo.getTaskState(r.taskId)).toBe("cancelled");
  });
  it("rejects unknown agents", async () => {
    await expect(
      orch.runTask({ workflowId, agentId: "nope", prompt: "x", cwd: "/w" }),
    ).rejects.toThrow();
  });
});

/** Adapter that runs a scripted list of steps; a step may throw. Counts how often execute() is called. */
class Scripted implements AgentAdapter {
  executions = 0;
  constructor(
    readonly id: string,
    private readonly steps: (AgentEvent | Error | { invalid: true })[],
  ) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(_task: AgentTask): AsyncIterable<AgentEvent> {
    this.executions++;
    for (const s of this.steps) {
      if (s instanceof Error) throw s;
      yield s as AgentEvent;
    }
  }
}

describe("Orchestrator: unverifiable side effects (C4)", () => {
  const call: AgentEvent = { type: "tool_call", name: "write_file", args: { path: "a" } };
  const setup = (steps: ConstructorParameters<typeof Scripted>[1]) => {
    const registry = new AdapterRegistry();
    const adapter = new Scripted("s", steps);
    registry.register(adapter);
    const sink = new Writable({ write: (_c, _e, cb) => cb() });
    return {
      adapter,
      o: new Orchestrator(registry, repo, createLogger({ name: "t", destination: sink })),
    };
  };

  it("adapter throws while a tool call is unfinished -> needs_reconciliation, never retried", async () => {
    const { adapter, o } = setup([call, new Error("process died")]);
    const r = await o.runTask({ workflowId, agentId: "s", prompt: "p", cwd: "/w" });
    expect(r.finalState).toBe("needs_reconciliation");
    expect(r.reason).toMatch(/unverified/);
    expect(repo.getTaskState(r.taskId)).toBe("needs_reconciliation");
    expect(repo.getTaskAttempt(r.taskId)).toBe(0);
    expect(adapter.executions).toBe(1);
    const evt = repo.listEvents(r.taskId).at(-1);
    expect(JSON.parse(evt?.payloadJson ?? "{}")).toMatchObject({
      from: "running",
      state: "needs_reconciliation",
    });
    expect(repo.listMessages(r.taskId).at(-1)?.payload).toMatchObject({
      needsReconciliation: true,
    });
  });

  it("stream cut with no terminal event and no tools is plain failed", async () => {
    const { o } = setup([{ type: "text", content: "hi" }]);
    const r = await o.runTask({ workflowId, agentId: "s", prompt: "p", cwd: "/w" });
    expect(r.finalState).toBe("failed");
  });

  it("an invalid event from the adapter is an abnormal end", async () => {
    const { o } = setup([call, { invalid: true }]);
    const r = await o.runTask({ workflowId, agentId: "s", prompt: "p", cwd: "/w" });
    expect(r.finalState).toBe("needs_reconciliation");
  });

  it("resolveReconciliation: only from needs_reconciliation; requeue bumps attempt; others do not re-run", async () => {
    const { adapter, o } = setup([call, new Error("died")]);
    const r = await o.runTask({ workflowId, agentId: "s", prompt: "p", cwd: "/w" });
    o.resolveReconciliation(r.taskId, "requeue", "checked the file, not written");
    expect(repo.getTaskState(r.taskId)).toBe("queued");
    expect(repo.getTaskAttempt(r.taskId)).toBe(1);
    expect(adapter.executions).toBe(1); // requeue does not run anything by itself
    expect(() => o.resolveReconciliation(r.taskId, "completed", "x")).toThrow(
      /not needs_reconciliation/,
    );

    const r2 = await setup([call, new Error("died")]).o.runTask({
      workflowId,
      agentId: "s",
      prompt: "p",
      cwd: "/w",
    });
    o.resolveReconciliation(r2.taskId, "completed", "verified by hand");
    expect(repo.getTaskState(r2.taskId)).toBe("completed");
    expect(JSON.parse(repo.listEvents(r2.taskId).at(-1)?.payloadJson ?? "{}").reason).toMatch(
      /reconciled by user: verified by hand/,
    );
  });
});
