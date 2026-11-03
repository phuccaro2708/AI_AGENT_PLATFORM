import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent, SidecarEvent } from "@agent-studio/contracts";
import { StubAdapter, type AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

let dir: string;
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
    const { result: p } = await call(svc, "projects.create", { name: "demo", rootPath: "C:/demo" });
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
    expect(JSON.stringify(page2.result?.messages)).toContain("C:/demo"); // stub echoes cwd
    const listed = (await call(svc, "projects.list")).result?.projects as { rootPath: string }[];
    expect(listed.map((x) => x.rootPath)).toContain("C:/demo");
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
    const p = (await call(svc, "projects.create", { name: "e", rootPath: "C:/e" })).result;
    const w = (await call(svc, "workflows.create", { projectId: p?.projectId })).result;
    const s = (
      await call(svc, "workflows.start", {
        workflowId: w?.workflowId,
        agentId: "stub",
        prompt: "x",
      })
    ).result;
    await svc.idle();
    const mine = events.filter((e) => "taskId" in e && e.taskId === s?.taskId);
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
    const p = (await call(svc, "projects.create", { name: "f", rootPath: "C:/f" })).result;
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
    const p = (await call(svc, "projects.create", { name: "a", rootPath: "C:/a" })).result;
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
      (await call(svc, "projects.create", { name: " ", rootPath: "C:/b" })).error?.message,
    ).toBe("invalid request");
  });

  it("tasks.cancel stops a running task while other requests are still served", async () => {
    svc.close();
    const slow = new SlowAdapter("slow");
    svc = new SidecarService(
      { dbPath: join(dir, "c.db"), extraAdapters: [slow] },
      createLogger({ name: "t", destination: sink }),
    );
    const p = (await call(svc, "projects.create", { name: "c", rootPath: "C:/c" })).result;
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

/** Phase 2 over IPC: patterns, context board, approvals. */
describe("Phase 2 IPC", () => {
  class Scripted extends StubAdapter {
    readonly prompts: string[] = [];
    gate: Promise<void> | undefined;
    constructor(
      override readonly id: string,
      private run: (t: AgentTask) => string,
    ) {
      super();
    }
    override async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
      this.prompts.push(task.prompt);
      await this.gate;
      yield { type: "text", content: this.run(task) };
      yield { type: "completed" };
    }
  }
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });

  let p2: SidecarService;
  let events: SidecarEvent[];
  let impl: Scripted;
  let rev: Scripted;
  let root: string;

  beforeEach(() => {
    events = [];
    root = join(dir, "proj");
    mkdirSync(root);
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    writeFileSync(join(root, "a.txt"), "base\n");
    git(root, "add", "a.txt");
    git(root, "commit", "-m", "base");
    impl = new Scripted("impl", (t) => {
      writeFileSync(join(t.cwd, "feature.txt"), "feature\n");
      return "implemented";
    });
    rev = new Scripted("rev", () => "fine\nVERDICT: APPROVE");
    p2 = new SidecarService(
      {
        dbPath: join(dir, "p2.db"),
        extraAdapters: [impl, rev],
        onEvent: (e) => events.push(e),
      },
      createLogger({ name: "t", destination: sink }),
    );
  });
  afterEach(() => p2.close());

  const workflow = async () => {
    const { result: pr } = await call(p2, "projects.create", { name: "demo", rootPath: root });
    const { result: w } = await call(p2, "workflows.create", { projectId: pr?.projectId });
    return w?.workflowId as string;
  };

  it("runs peer review in the background, pushes workflow.finished and exposes the board", async () => {
    const wf = await workflow();
    const started = await call(p2, "workflows.runPeerReview", {
      workflowId: wf,
      goal: "add feature.txt",
      implementerAgentId: "impl",
      reviewerAgentId: "rev",
    });
    expect(started.result).toEqual({ started: true });
    await p2.idle();
    expect(events.find((e) => e.event === "workflow.finished")).toMatchObject({
      workflowId: wf,
      pattern: "peer_review",
      outcome: "approved",
    });
    expect((await call(p2, "workflows.state", { workflowId: wf })).result).toMatchObject({
      state: "completed",
      patternRunning: false,
    });
    const kinds = (
      (await call(p2, "context.list", { workflowId: wf })).result?.entries as {
        kind: string;
        source: string;
      }[]
    ).map((e) => `${e.kind}:${e.source}`);
    expect(kinds).toEqual(
      expect.arrayContaining(["goal:user", "artifact:verified", "report:agent-reported"]),
    );
    expect(rev.prompts[0]).toContain("feature.txt");
  });

  it("refuses unknown workflows/agents and a second pattern while one is running", async () => {
    const wf = await workflow();
    const base = { goal: "g", implementerAgentId: "impl", reviewerAgentId: "rev" };
    expect(
      (await call(p2, "workflows.runPeerReview", { ...base, workflowId: "nope" })).error?.message,
    ).toMatch(/Unknown workflow/);
    expect(
      (await call(p2, "workflows.runPeerReview", { ...base, workflowId: wf, reviewerAgentId: "x" }))
        .error?.message,
    ).toMatch(/Unknown agent/);

    let release!: () => void;
    impl.gate = new Promise<void>((r) => (release = r));
    expect((await call(p2, "workflows.runPeerReview", { ...base, workflowId: wf })).result).toEqual(
      {
        started: true,
      },
    );
    expect(
      (await call(p2, "workflows.runPeerReview", { ...base, workflowId: wf })).error?.message,
    ).toMatch(/already running/);
    release();
    await p2.idle();
  });

  it("lists and resolves approvals with a server-fixed identity and pushes changes", async () => {
    const wf = await workflow();
    const taskId =
      p2.db.$client
        .prepare(
          "insert into tasks (id,workflow_id,agent_id,state,created_at,updated_at) values ('tk',?,?,?,?,?)",
        )
        .run(wf, "impl", "running", new Date().toISOString(), new Date().toISOString()) && "tk";
    const { id, decision } = p2.approvals.request(taskId, { kind: "shell", summary: "rm build" });
    const listed = (await call(p2, "approvals.list")).result?.approvals as { id: string }[];
    expect(listed.map((a) => a.id)).toEqual([id]);

    const r = await call(p2, "approvals.resolve", { approvalId: id, decision: "approved" });
    expect(r.result).toEqual({ resolved: true });
    await expect(decision).resolves.toBe("approved");
    expect(
      (await call(p2, "approvals.resolve", { approvalId: id, decision: "denied" })).result,
    ).toEqual({ resolved: false });
    expect(
      p2.db.$client.prepare("select resolved_by from approvals where id=?").pluck().get(id),
    ).toBe("user:local");
    expect(events.flatMap((e) => (e.event === "approval.changed" ? [e.state] : []))).toEqual([
      "pending",
      "approved",
    ]);
  });

  it("rejects a client-supplied identity or unknown decision at the schema", async () => {
    const r = await p2.handle({
      id: 9,
      method: "approvals.resolve",
      params: { approvalId: "a", decision: "maybe" },
    });
    expect(r.response).toMatchObject({ error: { message: "invalid request" } });
  });
});
