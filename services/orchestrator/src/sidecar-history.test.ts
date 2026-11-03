import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

/** Says whatever the prompt says, then completes. */
class Echo implements AgentAdapter {
  constructor(readonly id: string) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    yield { type: "text", content: `echo: ${task.prompt}` };
    yield { type: "completed" };
  }
}

let dir: string;
let svc: SidecarService;
let n = 0;

const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
};

async function runTask(projectId: string, agent: string, prompt: string) {
  const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
  await call("workflows.start", { workflowId, agentId: agent, prompt });
  await svc.idle();
  return workflowId;
}

interface Hist {
  tasks: { taskId: string; agentId: string; state: string; projectId: string }[];
}
interface Hits {
  hits: { taskId: string; snippet: string }[];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-hist-"));
  svc = new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      extraAdapters: [new Echo("a1"), new Echo("a2")],
      schedulerIntervalMs: 20,
    },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

async function twoProjects() {
  const roots = ["one", "two"].map((name) => {
    const rootPath = join(dir, name);
    mkdirSync(rootPath);
    return { name, rootPath };
  });
  const ids: string[] = [];
  for (const r of roots) {
    ids.push((await call<{ projectId: string }>("projects.create", r)).projectId);
  }
  return ids as [string, string];
}

describe("tasks.history", () => {
  it("lists tasks of every project, newest first, and filters by project, agent and state", async () => {
    const [p1, p2] = await twoProjects();
    await runTask(p1, "a1", "first");
    await runTask(p1, "a2", "second");
    await runTask(p2, "a1", "third");

    const all = await call<Hist>("tasks.history");
    expect(all.tasks).toHaveLength(3);

    const byProject = await call<Hist>("tasks.history", { projectId: p1 });
    expect(byProject.tasks).toHaveLength(2);
    expect(byProject.tasks.every((t) => t.projectId === p1)).toBe(true);

    const byAgent = await call<Hist>("tasks.history", { agentId: "a1" });
    expect(byAgent.tasks).toHaveLength(2);

    const done = await call<Hist>("tasks.history", { state: "completed" });
    expect(done.tasks).toHaveLength(3);
    expect((await call<Hist>("tasks.history", { state: "failed" })).tasks).toEqual([]);
  });

  it("pages with limit and offset and rejects an invalid state", async () => {
    const [p1] = await twoProjects();
    for (const t of ["x", "y", "z"]) await runTask(p1, "a1", t);
    const page1 = await call<Hist>("tasks.history", { limit: 2 });
    const page2 = await call<Hist>("tasks.history", { limit: 2, offset: 2 });
    expect(page1.tasks).toHaveLength(2);
    expect(page2.tasks).toHaveLength(1);
    expect(new Set([...page1.tasks, ...page2.tasks].map((t) => t.taskId)).size).toBe(3);
    await expect(call("tasks.history", { state: "bogus" })).rejects.toThrow();
  });
});

describe("logs.search", () => {
  it("finds messages case-insensitively, scoped by project or task", async () => {
    const [p1, p2] = await twoProjects();
    await runTask(p1, "a1", "Needle in project one");
    await runTask(p2, "a1", "nothing here");

    const hits = await call<Hits>("logs.search", { query: "NEEDLE" });
    expect(hits.hits.length).toBeGreaterThan(0);
    expect(hits.hits[0]!.snippet.toLowerCase()).toContain("needle");

    expect((await call<Hits>("logs.search", { query: "needle", projectId: p2 })).hits).toEqual([]);
    const taskId = hits.hits[0]!.taskId;
    expect(
      (await call<Hits>("logs.search", { query: "needle", taskId })).hits.length,
    ).toBeGreaterThan(0);
  });

  it("treats % and _ literally and refuses a one-character query", async () => {
    const [p1] = await twoProjects();
    await runTask(p1, "a1", "plain text only");
    expect((await call<Hits>("logs.search", { query: "%%" })).hits).toEqual([]);
    expect((await call<Hits>("logs.search", { query: "p_ain" })).hits).toEqual([]);
    await expect(call("logs.search", { query: "x" })).rejects.toThrow();
  });
});
