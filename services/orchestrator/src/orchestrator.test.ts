import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { AdapterRegistry, StubAdapter } from "@agent-studio/agent-core";
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
