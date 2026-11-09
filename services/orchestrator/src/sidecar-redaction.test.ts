import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
 * Phase 7 criterion: no password/token in the DB, logs or IPC. A fake agent prints the exact secret
 * values it was "given" (stdout-style text, stderr-style error, tool call/result, JSON, longer
 * strings) and we read EVERYTHING the sidecar produced. No real CLI is run.
 *
 * Known limits (documented in docs/SECURITY.md): only exact values of at least 6 characters are
 * masked; a value that was transformed (base64, URL-encoded, split in two chunks) is not caught.
 */
const CLAUDE_SECRET = "fake-claude-secret-value-for-test"; // pragma: allowlist secret
const CODEX_SECRET = "fake-codex-secret-value-for-test"; // pragma: allowlist secret
const SHORT_SECRET = "abc"; // pragma: allowlist secret

class Leaky implements AgentAdapter {
  constructor(
    readonly id: string,
    private readonly secrets: string[],
  ) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(_task: AgentTask): AsyncIterable<AgentEvent> {
    for (const s of this.secrets) {
      yield { type: "text", content: s };
      yield { type: "text", content: `ANTHROPIC_API_KEY=${s}\nPATH=/usr/bin` };
      yield {
        type: "tool_call",
        name: "bash",
        args: { command: `echo ${s}`, env: { K: s } },
        callId: "c1",
      };
      yield {
        type: "tool_result",
        result: { stdout: JSON.stringify({ key: s }), stderr: `bad ${s}` },
        callId: "c1",
      };
      yield { type: "usage", data: { note: `token ${s}` } };
    }
    yield { type: "error", message: `request failed with key ${this.secrets[0]}` };
  }
}

/** Leaks into a normal review step: its text becomes the context-board summary. */
class LeakyThenOk implements AgentAdapter {
  constructor(
    readonly id: string,
    private readonly secret: string,
  ) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    if (task.permissions === "workspace-write") {
      writeFileSync(join(task.cwd, "feature.txt"), "done\n");
      yield { type: "text", content: `done, my key was ${this.secret}` };
    } else {
      yield { type: "text", content: `{"verdict":"approve","comments":["saw ${this.secret}"]}` };
    }
    yield { type: "completed" };
  }
}

/** Throws with the secret in the message (an adapter bug); must not reach DB, log or response. */
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
    throw new Error(`spawn failed, env had ${CODEX_SECRET}`);
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let dir: string;
let svc: SidecarService;
let logged = "";
let pushed: SidecarEvent[] = [];
let n = 0;
const sink = new Writable({
  write: (c, _e, cb) => {
    logged += String(c);
    cb();
  },
});

const responses: string[] = [];
const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  responses.push(JSON.stringify(response));
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-redact-"));
  logged = "";
  pushed = [];
  responses.length = 0;
  svc = new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      secrets: {
        claude: { ANTHROPIC_API_KEY: CLAUDE_SECRET, SHORT_TOKEN: SHORT_SECRET },
        codex: { OPENAI_API_KEY: CODEX_SECRET },
      },
      extraAdapters: [
        new Leaky("leaky", [CLAUDE_SECRET, CODEX_SECRET]),
        new Throws(),
        new LeakyThenOk("leaky-impl", CLAUDE_SECRET),
        new LeakyThenOk("leaky-rev", CODEX_SECRET),
      ],
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
  rmSync(dir, { recursive: true, force: true });
});

/** Every row of every table, found through sqlite_master (no table list to forget to update). */
function dumpAllTables(): string {
  const c = svc.db.$client;
  const tables = c
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .pluck()
    .all() as string[];
  expect(tables.length).toBeGreaterThan(5); // the generic query really sees the schema
  return tables
    .map((t) => `${t}: ${JSON.stringify(c.prepare(`select * from "${t}"`).all())}`)
    .join("\n");
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

async function waitForWorkflow(workflowId: string) {
  for (let i = 0; i < 300; i++) {
    const r = await call<{ workflowState: string }>("tasks.list", { workflowId });
    if (r.workflowState === "completed" || r.workflowState === "failed") return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("workflow did not settle");
}

describe("redaction of loaded secrets (Phase 7 criterion)", () => {
  it("masks exact secret values in the DB, log, IPC responses and pushed events", async () => {
    const projectId = await project();
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    for (const agentId of ["leaky", "throws"]) {
      await call("workflows.start", { workflowId, agentId, prompt: "go" });
      await svc.idle();
    }
    // Peer review: the secret ends up in the implementer summary and in the reviewer comments.
    const wf2 = (await call<{ workflowId: string }>("workflows.create", { projectId })).workflowId;
    await call("workflows.startPeerReview", {
      workflowId: wf2,
      implementerAgent: "leaky-impl",
      reviewerAgent: "leaky-rev",
      goal: "add feature.txt",
    });
    await waitForWorkflow(wf2);

    // Read through every IPC surface that returns stored text.
    const { tasks } = await call<{ tasks: { id: string }[] }>("tasks.list", { workflowId });
    for (const t of tasks) await call("logs.query", { taskId: t.id, afterSequence: 0, limit: 200 });
    await call("tasks.history", {});
    await call("tasks.list", { workflowId: wf2 });
    await call("context.list", { workflowId: wf2 });
    await call("roles.list", { workflowId: wf2 });
    await call("approvals.list", {});
    await call("worktrees.list", { workflowId: wf2 });
    for (const m of ["agents.list", "agents.detect", "health"]) await call(m);
    for (const provider of ["claude", "codex"]) await call("agents.getSettings", { provider });
    // Searching FOR the secret must not find it (the snippet would print it back).
    const hits = await call<{ hits: unknown[] }>("logs.search", { query: CLAUDE_SECRET });
    expect(hits.hits).toEqual([]);
    const around = await call<{ hits: { snippet: string }[] }>("logs.search", {
      query: "ANTHROPIC_API_KEY=",
    });
    expect(around.hits.length).toBeGreaterThan(0);

    // Sanity: the leak really was exercised and stored, only masked.
    const stored = dumpAllTables();
    expect(stored).toContain("ANTHROPIC_API_KEY=");
    expect(stored).toContain("[REDACTED]");

    svc.close();
    const files = readdirSync(dir).filter((f) => f.startsWith("s.db"));
    const haystack = [
      logged,
      stored,
      ...responses,
      ...pushed.map((e) => JSON.stringify(e)),
      ...files.map((f) => readFileSync(join(dir, f)).toString("latin1")),
    ].join("\n");
    for (const secret of [CLAUDE_SECRET, CODEX_SECRET]) {
      expect(haystack).not.toContain(secret);
      expect(haystack).not.toContain(JSON.stringify(secret).slice(1, -1) + "\\n");
    }
    expect(pushed.some((e) => e.event === "task.message")).toBe(true);
  }, 30_000);

  it("keeps sequence numbers contiguous and every event of the task stored", async () => {
    const projectId = await project();
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    await call("workflows.start", { workflowId, agentId: "leaky", prompt: "go" });
    await svc.idle();
    const { tasks } = await call<{ tasks: { id: string; state: string }[] }>("tasks.list", {
      workflowId,
    });
    const { messages } = await call<{ messages: { sequence: number; type: string }[] }>(
      "logs.query",
      { taskId: tasks[0]!.id, afterSequence: 0, limit: 200 },
    );
    // `afterSequence: 0` is exclusive, so task.request (sequence 0, written when the task is queued) is not
    // listed: then task.accepted, 5 progress events per secret x 2 and the failure, numbered without gaps.
    expect(messages.map((m) => m.sequence)).toEqual(messages.map((_m, i) => i + 1));
    expect(messages.at(-1)?.type).toBe("task.failed");
    expect(messages).toHaveLength(12);
  });

  it("does not mask values shorter than 6 characters (documented limit)", async () => {
    const projectId = await project();
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    await call("workflows.start", { workflowId, agentId: "leaky", prompt: "go" });
    await svc.idle();
    // "abc" is a 3-char secret value: masking it would shred ordinary words ("abc", "tabcloth").
    await call("workflows.start", { workflowId, agentId: "leaky", prompt: `use ${SHORT_SECRET}` });
    await svc.idle();
    expect(dumpAllTables()).toContain(`use ${SHORT_SECRET}`);
  });
});
