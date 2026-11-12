import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real git/SQLite/filesystem work: the whole suite runs these files in parallel, so the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent, SidecarEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

/**
 * No registered secret in the DB, the log, IPC responses or pushed events.
 * Complements sidecar-redaction.test.ts: secrets whose JSON-escaped form DIFFERS from the raw form (quote,
 * backslash, non-ASCII), every event field an agent controls (text, tool_call name/args keys and values,
 * tool_result, usage, error, malformed events, thrown errors), the secret in the user's own prompt, and every
 * IPC surface including artifacts and diffs. No real CLI is run.
 *
 * Each surface is scanned for three spellings: raw, JSON-escaped (what it looks like inside a stored JSON
 * string) and escaped twice (what a JSON string inside a JSON string looks like, e.g. in a log line).
 * Findings that are real leaks are `it.fails` and listed in the P4-6 report; they must not be fixed by this lane.
 */
const SECRET_A = 'fake-"quoted"\\back-ü-secret-A1'; // pragma: allowlist secret
const SECRET_B = "fake-plain-secret-value-B2"; // pragma: allowlist secret
const forms = (s: string): string[] => {
  const once = JSON.stringify(s).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  return [...new Set([s, once, twice])];
};
const ALL_FORMS = [...forms(SECRET_A), ...forms(SECRET_B)];

class Leaky implements AgentAdapter {
  readonly id = "leaky";
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    for (const s of [SECRET_A, SECRET_B]) {
      yield { type: "text", content: `raw ${s}` };
      yield { type: "text", content: `json ${JSON.stringify({ key: s })}` };
      yield {
        type: "tool_call",
        name: `tool-${s}`,
        args: { [`k-${s}`]: s, nested: { list: [s, { deep: s }] }, command: `echo ${s}` },
        callId: "c1",
      };
      yield {
        type: "tool_result",
        result: { stdout: JSON.stringify({ key: s }), [`k-${s}`]: [s] },
        callId: "c1",
      };
      yield { type: "usage", data: { note: `token ${s}`, [s]: 1 } };
    }
    writeFileSync(join(task.cwd, "from-agent.txt"), "ok\n");
    yield { type: "error", message: `request failed with key ${SECRET_A} and ${SECRET_B}` };
  }
}

/** Emits a malformed event that carries the secret (validation errors may echo the offending value). */
class Malformed implements AgentAdapter {
  readonly id = "malformed";
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(): AsyncIterable<AgentEvent> {
    yield { type: "text", content: 5, extra: SECRET_A, other: SECRET_B } as unknown as AgentEvent;
    yield { type: SECRET_B, content: SECRET_A } as unknown as AgentEvent;
  }
}

class Throws implements AgentAdapter {
  readonly id = "throws";
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  // eslint-disable-next-line require-yield
  async *execute(): AsyncIterable<AgentEvent> {
    throw new Error(`spawn failed, env had ${SECRET_A} and ${SECRET_B}`);
  }
}

/** Writes the secret into a file of the workspace and says it is done (a file leak is not an event leak). */
class WritesSecretFile implements AgentAdapter {
  readonly id = "writer";
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    writeFileSync(join(task.cwd, "notes.txt"), `key=${SECRET_B}\n`);
    yield { type: "text", content: "done" };
    yield { type: "completed" };
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let dir: string;
let svc: SidecarService;
let logged = "";
let pushed: SidecarEvent[] = [];
let n = 0;
const responses: string[] = [];
const sink = new Writable({
  write: (c, _e, cb) => {
    logged += String(c);
    cb();
  },
});

type Rpc = { result?: unknown; error?: { message: string } };
const rpc = async (method: string, params?: unknown): Promise<Rpc> => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  responses.push(JSON.stringify(response)); // errors are scanned too
  return response as Rpc;
};
const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const r = await rpc(method, params);
  if (r.error) throw new Error(r.error.message);
  return r.result as T;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-leak-"));
  logged = "";
  pushed = [];
  responses.length = 0;
  svc = new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      secrets: { claude: { ANTHROPIC_API_KEY: SECRET_A }, codex: { OPENAI_API_KEY: SECRET_B } },
      extraAdapters: [new Leaky(), new Malformed(), new Throws(), new WritesSecretFile()],
      worktreesDir: join(dir, "wt"),
      schedulerIntervalMs: 20,
      onEvent: (e) => pushed.push(e),
      probes: {},
    },
    createLogger({ name: "t", destination: sink }),
  );
});
afterEach(() => {
  svc?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const NL = String.fromCharCode(10);
function dumpAllTables(): string {
  const c = svc.db.$client;
  const tables = c
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .pluck()
    .all() as string[];
  expect(tables.length).toBeGreaterThan(5);
  // Raw cell values, not JSON.stringify(rows): that would add one more level of escaping and hide the real spelling.
  return tables
    .map(
      (t) =>
        `${t}: ` +
        (c.prepare(`select * from "${t}"`).all() as Record<string, unknown>[])
          .map((row) => Object.values(row).map(String).join(" | "))
          .join(" || "),
    )
    .join(NL);
}

async function project(): Promise<string> {
  const root = join(dir, "p");
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, "README.md"), "hi\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return (await call<{ projectId: string }>("projects.create", { name: "p", rootPath: root }))
    .projectId;
}

/** Which (surface, spelling) pairs contain a secret. Empty = clean. */
function leaks(surfaces: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, text] of Object.entries(surfaces)) {
    for (const f of ALL_FORMS) if (text.includes(f)) out.push(`${name}: ${JSON.stringify(f)}`);
  }
  return out;
}

/** Every IPC method that returns stored text, called with real ids. */
async function readEverything(projectId: string, workflowIds: string[]) {
  await call("projects.list");
  for (const m of ["agents.list", "agents.detect", "health", "tasks.history"]) await call(m);
  for (const provider of ["claude", "codex"]) await call("agents.getSettings", { provider });
  await call("approvals.list", {});
  for (const workflowId of workflowIds) {
    const { tasks } = await call<{ tasks: { id: string }[] }>("tasks.list", { workflowId });
    for (const t of tasks) {
      await call("logs.query", { taskId: t.id, afterSequence: -1, limit: 1000 });
      await rpc("artifacts.list", { taskId: t.id });
    }
    for (const m of ["context.list", "roles.list", "worktrees.list"]) {
      await rpc(m, { workflowId });
    }
  }
  for (const query of ["raw", "json", "token", "failed", "REDACTED", "request", "spawn"]) {
    await call("logs.search", { query });
  }
  // Searching FOR a secret must not echo it back, whichever way it is spelled.
  for (const f of ALL_FORMS) await rpc("logs.search", { query: f });
  void projectId;
}

function surfaces(): Record<string, string> {
  svc.close();
  const files = readdirSync(dir).filter((f) => f.startsWith("s.db"));
  return {
    log: logged,
    "IPC responses": responses.join("\n"),
    "pushed events": pushed.map((e) => JSON.stringify(e)).join("\n"),
    "sqlite files (db, wal, shm)": files
      .map((f) => readFileSync(join(dir, f)).toString("latin1"))
      .join("\n"),
  };
}

async function runAgents(agentIds: string[]) {
  const projectId = await project();
  const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
  for (const agentId of agentIds) {
    await call("workflows.start", { workflowId, agentId, prompt: "go" });
    await svc.idle();
  }
  return { projectId, workflowId };
}

describe("P4-6: no registered secret in DB, log, IPC or pushed events (fake agents)", () => {
  it("sanity: the redactor is active and the agent really leaks (only masked copies are stored)", async () => {
    const { projectId, workflowId } = await runAgents(["leaky"]);
    await readEverything(projectId, [workflowId]);
    const stored = dumpAllTables();
    expect(stored).toContain("[REDACTED]");
    expect(stored).toContain("raw [REDACTED]");
    expect(pushed.some((e) => e.event === "task.message")).toBe(true);
  }, 30_000);

  it("agent text, tool_call name/args (keys and values), tool_result, usage and error are masked everywhere", async () => {
    const { projectId, workflowId } = await runAgents(["leaky"]);
    await readEverything(projectId, [workflowId]);
    const stored = dumpAllTables();
    const found = leaks({ "DB rows": stored, ...surfaces() });
    expect(found).toEqual([]);
  }, 30_000);

  it("a malformed event or a thrown error that echoes the secret leaves no trace", async () => {
    const { projectId, workflowId } = await runAgents(["malformed", "throws"]);
    await readEverything(projectId, [workflowId]);
    const stored = dumpAllTables();
    expect(stored).toContain("adapter"); // the failure itself was recorded
    expect(leaks({ "DB rows": stored, ...surfaces() })).toEqual([]);
  }, 30_000);

  it("the secret typed in the user's own prompt or project name is masked before it is stored or echoed", async () => {
    const projectId = await project();
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    await call("workflows.start", {
      workflowId,
      agentId: "writer",
      prompt: `use ${SECRET_A} and ${SECRET_B} please`,
    });
    await svc.idle();
    await rpc("projects.create", { name: `n-${SECRET_B}`, rootPath: join(dir, "p2") });
    await readEverything(projectId, [workflowId]);
    const found = leaks({ "DB rows": dumpAllTables(), ...surfaces() });
    expect(found).toEqual([]);
  }, 30_000);

  // Was a product bug (the goal was stored and returned unmasked); fixed upstream in c774611: regression test.
  it("a secret typed into the peer-review goal is stored, returned and pushed masked", async () => {
    const projectId = await project();
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    await call("workflows.startPeerReview", {
      workflowId,
      implementerAgent: "writer",
      reviewerAgent: "leaky",
      goal: `ship it, token ${SECRET_A}`,
    });
    for (let i = 0; i < 300; i++) {
      const r = await call<{ workflowState: string }>("tasks.list", { workflowId });
      if (r.workflowState === "completed" || r.workflowState === "failed") break;
      await new Promise((res) => setTimeout(res, 25));
    }
    await readEverything(projectId, [workflowId]);
    expect(leaks({ "DB rows": dumpAllTables(), ...surfaces() })).toEqual([]);
  }, 30_000);

  // The secret is in a FILE the agent wrote (not in an event). The orchestrator's file diff / artifact surfaces
  // show file content verbatim. Probed empirically; see the result in the P4-6 report.
  it("a secret the agent wrote into a workspace file is masked in artifacts.diff", async () => {
    const projectId = await project();
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    await call("workflows.start", { workflowId, agentId: "writer", prompt: "write notes" });
    await svc.idle();
    const { tasks } = await call<{ tasks: { id: string }[] }>("tasks.list", { workflowId });
    const diff = await rpc("artifacts.diff", { taskId: tasks[0]!.id });
    const list = await rpc("artifacts.list", { taskId: tasks[0]!.id });
    void projectId;
    expect(leaks({ diff: JSON.stringify(diff), list: JSON.stringify(list) })).toEqual([]);
  }, 30_000);
});
