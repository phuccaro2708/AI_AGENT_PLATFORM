import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent, SidecarEvent } from "@agent-studio/contracts";
import { StubAdapter, type AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

let dir: string;
/** A real project folder inside the test directory (the policy refuses folders that do not exist). */
const folder = (name: string): string => {
  const p = join(dir, "projects", name);
  mkdirSync(p, { recursive: true });
  return realpathSync.native(p);
};
let svc: SidecarService;
const sink = new Writable({ write: (_c, _e, cb) => cb() });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-sidecar-"));
  svc = new SidecarService(
    { dbPath: join(dir, "s.db") },
    createLogger({ name: "t", destination: sink }),
  );
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SidecarService", () => {
  it("answers health with WAL journal mode", async () => {
    const { response } = await svc.handle({ id: 1, method: "health" });
    expect(response).toMatchObject({ id: 1, result: { journalMode: "wal" } });
  });
  it("runs the stub and persists, then queryTask sees it", async () => {
    const run = await svc.handle({ id: 2, method: "runStub", params: { prompt: "hi" } });
    const result = (run.response as { result: { taskId: string; finalState: string } }).result;
    expect(result.finalState).toBe("completed");
    const q = await svc.handle({ id: 3, method: "queryTask", params: { taskId: result.taskId } });
    expect(q.response).toMatchObject({ id: 3, result: { state: "completed" } });
  });
  it("rejects invalid requests without throwing", async () => {
    const { response } = await svc.handle({ id: 4, method: "nope" });
    expect(response).toMatchObject({ id: 4, error: { message: "invalid request" } });
  });
  it("on restart, a task left running becomes needs_reconciliation and health reports it (D4)", async () => {
    const seeded = svc.db.$client;
    const repoSql = (q: string, ...a: unknown[]) => seeded.prepare(q).run(...a);
    const ts = new Date().toISOString();
    repoSql("insert into projects (id,name,root_path,created_at) values ('p','n','r',?)", ts);
    repoSql(
      "insert into workflows (id,project_id,state,created_at) values ('w','p','pending',?)",
      ts,
    );
    repoSql(
      "insert into tasks (id,workflow_id,state,created_at,updated_at) values ('t','w','running',?,?)",
      ts,
      ts,
    );
    svc.close(); // simulate a crash: the row stays `running`

    svc = new SidecarService(
      { dbPath: join(dir, "s.db") },
      createLogger({ name: "t", destination: sink }),
    );
    const q = await svc.handle({ id: 6, method: "queryTask", params: { taskId: "t" } });
    expect(q.response).toMatchObject({ result: { state: "needs_reconciliation" } });
    const h = await svc.handle({ id: 7, method: "health" });
    expect(h.response).toMatchObject({ result: { recoveredTasks: 1 } });
  });
  it("flags shutdown", async () => {
    expect((await svc.handle({ id: 5, method: "shutdown" })).shutdown).toBe(true);
  });
});

/** Waits for the abort signal, so a test can cancel while the task is genuinely running. */
class SlowAdapter extends StubAdapter {
  started!: () => void;
  readonly running = new Promise<void>((r) => (this.started = r));
  override async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    yield { type: "text", content: "working" };
    this.started();
    await new Promise<void>((r) =>
      task.signal.addEventListener("abort", () => r(), { once: true }),
    );
    yield { type: "error", message: "cancelled" };
  }
}
const call = async (s: SidecarService, method: string, params?: unknown) => {
  const { response } = await s.handle({ id: 1, method, ...(params ? { params } : {}) });
  // Test helper: responses are untyped JSON, so field access is deliberately loose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return response as { result?: Record<string, any>; error?: { message: string } };
};

describe("D1 IPC", () => {
  it("projects -> workflow -> start -> logs.query, with cwd taken from the project root", async () => {
    const { result: p } = await call(svc, "projects.create", {
      name: "demo",
      rootPath: folder("demo"),
    });
    const { result: w } = await call(svc, "workflows.create", { projectId: p?.projectId });
    const { result: s } = await call(svc, "workflows.start", {
      workflowId: w?.workflowId,
      agentId: "stub",
      prompt: "hello",
    });
    await svc.idle();
    const taskId = s?.taskId as string;
    expect((await call(svc, "queryTask", { taskId })).result?.state).toBe("completed");

    const page1 = await call(svc, "logs.query", { taskId, limit: 2 });
    expect(page1.result?.messages).toHaveLength(2);
    const page2 = await call(svc, "logs.query", {
      taskId,
      afterSequence: page1.result?.nextAfterSequence,
    });
    expect(page2.result?.messages.length).toBeGreaterThan(0);
    expect(page2.result?.messages[0].sequence).toBe(page1.result?.nextAfterSequence + 1);
    expect(JSON.stringify(page2.result?.messages)).toContain(
      JSON.stringify(folder("demo")).slice(1, -1), // stub echoes cwd; JSON escapes backslashes
    );
    const listed = (await call(svc, "projects.list")).result?.projects as { rootPath: string }[];
    expect(listed.map((x) => x.rootPath)).toContain(folder("demo"));
  });

  it("adds no project on a fresh start (the Phase 0 spike project is created only by runStub)", async () => {
    const fresh = new SidecarService(
      { dbPath: join(dir, "fresh.db") },
      createLogger({ name: "t", destination: sink }),
    );
    try {
      expect((await call(fresh, "projects.list")).result?.projects).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it("pushes task.message in sequence order and a final task.state (D2)", async () => {
    svc.close();
    const events: SidecarEvent[] = [];
    svc = new SidecarService(
      { dbPath: join(dir, "e.db"), onEvent: (e) => events.push(e) },
      createLogger({ name: "t", destination: sink }),
    );
    const p = (await call(svc, "projects.create", { name: "e", rootPath: folder("e") })).result;
    const w = (await call(svc, "workflows.create", { projectId: p?.projectId })).result;
    const s = (
      await call(svc, "workflows.start", {
        workflowId: w?.workflowId,
        agentId: "stub",
        prompt: "x",
      })
    ).result;
    await svc.idle();
    const mine = events.filter((e) => e.taskId === s?.taskId);
    const seqs = mine.flatMap((e) => (e.event === "task.message" ? [e.sequence] : []));
    expect(seqs.length).toBeGreaterThan(2);
    expect(seqs).toEqual(seqs.map((_, i) => i)); // contiguous from 0
    expect(mine.at(0)).toMatchObject({ event: "task.state", state: "running" });
    expect(mine.at(-1)).toMatchObject({ event: "task.state", state: "completed" });
    // Same data the log view returns: events are a live view of persisted messages.
    const logged = (await call(svc, "logs.query", { taskId: s?.taskId })).result?.messages;
    expect(logged).toHaveLength(seqs.length);
  });

  it("a throwing listener cannot fail the task", async () => {
    svc.close();
    svc = new SidecarService(
      {
        dbPath: join(dir, "f.db"),
        onEvent: () => {
          throw new Error("ui gone");
        },
      },
      createLogger({ name: "t", destination: sink }),
    );
    const p = (await call(svc, "projects.create", { name: "f", rootPath: folder("f") })).result;
    const w = (await call(svc, "workflows.create", { projectId: p?.projectId })).result;
    const s = (
      await call(svc, "workflows.start", {
        workflowId: w?.workflowId,
        agentId: "stub",
        prompt: "x",
      })
    ).result;
    await svc.idle();
    expect((await call(svc, "queryTask", { taskId: s?.taskId })).result?.state).toBe("completed");
  });

  it("rejects unknown ids and agents with a message, not a crash", async () => {
    expect((await call(svc, "workflows.create", { projectId: "nope" })).error?.message).toMatch(
      /Unknown project/,
    );
    expect(
      (await call(svc, "workflows.start", { workflowId: "nope", agentId: "stub", prompt: "x" }))
        .error?.message,
    ).toMatch(/Unknown workflow/);
    expect((await call(svc, "tasks.cancel", { taskId: "nope" })).error?.message).toMatch(
      /Unknown task/,
    );
    expect((await call(svc, "logs.query", { taskId: "nope" })).error?.message).toMatch(
      /Unknown task/,
    );
    const p = (await call(svc, "projects.create", { name: "a", rootPath: folder("a") })).result;
    const w = (await call(svc, "workflows.create", { projectId: p?.projectId })).result;
    expect(
      (
        await call(svc, "workflows.start", {
          workflowId: w?.workflowId,
          agentId: "ghost",
          prompt: "x",
        })
      ).error?.message,
    ).toMatch(/Unknown agent/);
    expect(
      (await call(svc, "projects.create", { name: " ", rootPath: folder("b") })).error?.message,
    ).toBe("invalid request");
  });

  it("tasks.cancel stops a running task while other requests are still served", async () => {
    svc.close();
    const slow = new SlowAdapter("slow");
    svc = new SidecarService(
      { dbPath: join(dir, "c.db"), extraAdapters: [slow] },
      createLogger({ name: "t", destination: sink }),
    );
    const p = (await call(svc, "projects.create", { name: "c", rootPath: folder("c") })).result;
    const w = (await call(svc, "workflows.create", { projectId: p?.projectId })).result;
    const s = (
      await call(svc, "workflows.start", {
        workflowId: w?.workflowId,
        agentId: "slow",
        prompt: "x",
      })
    ).result;
    await slow.running;
    expect((await call(svc, "queryTask", { taskId: s?.taskId })).result?.state).toBe("running");
    expect((await call(svc, "tasks.cancel", { taskId: s?.taskId })).result?.requested).toBe(true);
    await svc.idle();
    expect((await call(svc, "queryTask", { taskId: s?.taskId })).result?.state).toBe("cancelled");
    const again = await call(svc, "tasks.cancel", { taskId: s?.taskId });
    expect(again.result).toMatchObject({ requested: false, state: "cancelled" });
  });

  it("agents.detect stores the probe result; agents.list/capabilities read it back", async () => {
    svc.close();
    svc = new SidecarService(
      {
        dbPath: join(dir, "d.db"),
        probes: {
          claude: async () => ({
            provider: "claude",
            status: "ok",
            version: "2.1.314 (Claude Code)",
            capabilities: { print: true },
            evidence: [],
            probedAt: "2026-01-01T00:00:00.000Z",
          }),
          codex: async () => ({
            provider: "codex",
            status: "not_installed",
            capabilities: {},
            evidence: [],
            error: { status: "not_installed", message: "not found" },
            probedAt: "2026-01-01T00:00:00.000Z",
          }),
        },
      },
      createLogger({ name: "t", destination: sink }),
    );
    const d = await call(svc, "agents.detect");
    expect(d.result?.results).toHaveLength(2);
    const caps = await call(svc, "agents.capabilities", { provider: "claude" });
    expect(caps.result?.probe).toMatchObject({ status: "ok", capabilities: { print: true } });
    const list = await call(svc, "agents.list");
    expect(list.result?.adapters[0]).toMatchObject({ id: "stub", available: true });
    expect(list.result?.cli).toHaveLength(2);
    expect(
      (await call(svc, "agents.capabilities", { provider: "claude" })).result?.probe.version,
    ).toContain("2.1.314");
  });
});
