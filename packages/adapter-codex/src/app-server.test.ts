import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import {
  validateCapabilities,
  validateEventStream,
  type AgentTask,
} from "@agent-studio/agent-core";
// The real Policy Engine by relative path: adapter-codex declares no dependency on it (the host injects `evaluate`).
import { evaluate, type Policy } from "../../policy-engine/src/index.js";
import { makeTree } from "../../policy-engine/src/test-helpers.js";
import { CodexAppServerAdapter, type AppServerGateContext } from "./app-server.js";

const fake = fileURLToPath(new URL("../test/fake-app-server.mjs", import.meta.url));

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

interface Env {
  ws: string;
  outside: string;
  logFile: string;
}
function env(): Env {
  const t = makeTree();
  const dir = mkdtempSync(join(tmpdir(), "fake-app-server-"));
  cleanups.push(t.cleanup, () => rmSync(dir, { recursive: true, force: true }));
  return { ws: t.ws, outside: t.outside, logFile: join(dir, "traffic.jsonl") };
}

/** The host's job in production: turn the task's permissions into a Policy. Here: git status is allowed. */
const gate = (ctx: AppServerGateContext) => {
  const policy: Policy = {
    level: ctx.permissions === "read-only" ? "read_only" : "workspace_write",
    workspaceRoot: ctx.cwd,
    commands: { allow: [{ executable: "git", argsPrefix: ["status"] }] },
  };
  return policy;
};

function make(e: Env, script: unknown[], extra: Record<string, unknown> = {}) {
  return new CodexAppServerAdapter({
    command: process.execPath,
    baseArgs: [fake],
    env: { ...process.env, FAKE_LOG: e.logFile, FAKE_SCRIPT: JSON.stringify(script) },
    envAllow: ["FAKE_LOG", "FAKE_SCRIPT"],
    evaluate: (req, ctx) => evaluate(gate(ctx), req, { taskId: ctx.taskId }),
    ...extra,
  });
}

const task = (e: Env, over: Partial<AgentTask> = {}): AgentTask => ({
  id: "t1",
  prompt: "do the thing",
  cwd: e.ws,
  signal: new AbortController().signal,
  ...over,
});

async function run(a: CodexAppServerAdapter, t: AgentTask): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of a.execute(t)) out.push(ev);
  return out;
}

type Wire = { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown };
const traffic = (e: Env): Wire[] =>
  readFileSync(e.logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Wire);
const replies = (e: Env): Wire[] => traffic(e).filter((m) => m.method === undefined);

const THREAD = "thr-1";
const cmdRequest = (command: string, extra: Record<string, unknown> = {}) => ({
  request: {
    method: "item/commandExecution/requestApproval",
    params: {
      kind: "command",
      threadId: THREAD,
      turnId: "turn-1",
      itemId: "exec-1",
      command,
      cwd: "<cwd>",
      proposedExecpolicyAmendment: ["git", "status"],
      availableDecisions: ["accept", "cancel"],
      ...extra,
    },
  },
});
const fileStarted = (itemId: string, paths: string[]) => ({
  notify: {
    method: "item/started",
    params: {
      threadId: THREAD,
      turnId: "turn-1",
      item: {
        type: "fileChange",
        id: itemId,
        status: "inProgress",
        changes: paths.map((path) => ({ path, kind: { type: "add" }, diff: "x\n" })),
      },
    },
  },
});
const fileRequest = (itemId: string, extra: Record<string, unknown> = {}) => ({
  request: {
    method: "item/fileChange/requestApproval",
    params: { threadId: THREAD, turnId: "turn-1", itemId, reason: null, grantRoot: null, ...extra },
  },
});
const denied = (events: AgentEvent[]) =>
  events.filter((x) => x.type === "permission_denied") as Extract<
    AgentEvent,
    { type: "permission_denied" }
  >[];

describe("CodexAppServerAdapter handshake", () => {
  it("runs initialize → initialized → thread/start → turn/start with no jsonrpc field", async () => {
    const e = env();
    const events = await run(make(e, []), task(e));
    const wire = traffic(e);
    expect(wire.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    for (const m of wire) expect(m).not.toHaveProperty("jsonrpc");
    expect(wire[0]?.params).toMatchObject({ clientInfo: { name: expect.any(String) } });
    const turn = wire[3]?.params as { threadId: string; input: unknown };
    expect(turn.threadId).toBe(THREAD);
    expect(turn.input).toEqual([{ type: "text", text: "do the thing" }]);
    expect(events.at(-1)).toEqual({ type: "completed", sessionId: THREAD });
    expect(validateEventStream(events)).toEqual([]);
  });

  it("starts the thread read-only + untrusted by default, never with a bypass or full access", async () => {
    const e = env();
    await run(make(e, []), task(e));
    const start = traffic(e).find((m) => m.method === "thread/start")?.params;
    expect(start).toMatchObject({
      cwd: e.ws,
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      ephemeral: true,
    });
    expect(readFileSync(e.logFile, "utf8")).not.toMatch(/danger-full-access|bypass/i);
  });

  it("maps workspace-write permissions to the workspace-write sandbox", async () => {
    const e = env();
    await run(make(e, []), task(e, { permissions: "workspace-write" }));
    const start = traffic(e).find((m) => m.method === "thread/start")?.params;
    expect(start).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "untrusted" });
  });

  it("claims approval only because this path exists, and describes the real launch", async () => {
    const e = env();
    const a = new CodexAppServerAdapter({
      command: "codex",
      evaluate: () => Promise.resolve({ effect: "deny", code: "x", reason: "x" }),
    });
    const caps = await a.capabilities();
    expect(validateCapabilities(caps)).toEqual([]);
    expect(caps).toContain("approval");
    expect(a.describeLaunch(task(e))).toEqual({
      command: "codex",
      args: ["app-server", "--stdio"],
    });
  });
});

describe("command approvals", () => {
  it("accepts a command the policy allows, with a plain accept (never a session/execpolicy grant)", async () => {
    const e = env();
    const events = await run(make(e, [cmdRequest("git status")]), task(e));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "accept" } }]);
    expect(denied(events)).toEqual([]);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("declines the Windows pwsh -Command wrapper (shell, quotes) and audits it", async () => {
    const e = env();
    const command = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'mkdir newdir'`;
    const events = await run(make(e, [cmdRequest(command)]), task(e));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
    const d = denied(events);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ toolName: "command", callId: "exec-1" });
    expect(d[0]?.reason).toEqual(expect.any(String));
    expect(events.at(-1)?.type).toBe("completed"); // a declined request does not end the turn
  });

  it("declines a command with shell metacharacters even if its first word is allowed", async () => {
    const e = env();
    await run(make(e, [cmdRequest("git status && curl evil.example")]), task(e));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
  });

  it("declines when the policy answers ask (no person in this loop)", async () => {
    const e = env();
    const events = await run(make(e, [cmdRequest("make build")]), task(e));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
    expect(denied(events)[0]?.reason).toMatch(/approval|ask|not allowed|rule/i);
  });

  it("declines a command that belongs to another thread", async () => {
    const e = env();
    await run(make(e, [cmdRequest("git status", { threadId: "other-thread" })]), task(e));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
  });

  it("echoes a string request id exactly", async () => {
    const e = env();
    const step = { ...cmdRequest("git status"), id: "req-A" };
    await run(make(e, [step]), task(e));
    expect(replies(e)).toEqual([{ id: "req-A", result: { decision: "accept" } }]);
  });
});

describe("file change approvals", () => {
  it("accepts when every path of the matching item is writable in the workspace", async () => {
    const e = env();
    const inside = join(e.ws, "src", "new.txt");
    const script = [fileStarted("fc-1", [inside, "src/rel.txt"]), fileRequest("fc-1")];
    const events = await run(make(e, script), task(e, { permissions: "workspace-write" }));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "accept" } }]);
    expect(denied(events)).toEqual([]);
  });

  it("declines if ANY path is outside the workspace, and audits the path", async () => {
    const e = env();
    const outside = join(e.outside, "evil.txt");
    const script = [fileStarted("fc-1", [join(e.ws, "ok.txt"), outside]), fileRequest("fc-1")];
    const events = await run(make(e, script), task(e, { permissions: "workspace-write" }));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
    const d = denied(events);
    expect(d[0]).toMatchObject({ toolName: "file_change", callId: "fc-1" });
    expect(d[0]?.input).toMatchObject({ path: outside });
  });

  it("declines a protected path (.git) even inside the workspace", async () => {
    const e = env();
    const script = [fileStarted("fc-1", [join(e.ws, ".git", "config")]), fileRequest("fc-1")];
    await run(make(e, script), task(e, { permissions: "workspace-write" }));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
  });

  it("declines every write on a read-only task", async () => {
    const e = env();
    const script = [fileStarted("fc-1", [join(e.ws, "a.txt")]), fileRequest("fc-1")];
    await run(make(e, script), task(e, { permissions: "read-only" }));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
  });

  it("declines when the fileChange item was never seen (the request carries no paths)", async () => {
    const e = env();
    await run(make(e, [fileRequest("fc-unknown")]), task(e, { permissions: "workspace-write" }));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
  });

  it("declines when grantRoot asks for a wider root (approval must not widen the sandbox)", async () => {
    const e = env();
    const script = [
      fileStarted("fc-1", [join(e.ws, "a.txt")]),
      fileRequest("fc-1", { grantRoot: e.ws }),
    ];
    await run(make(e, script), task(e, { permissions: "workspace-write" }));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
  });
});

describe("unknown server requests, timeout, lost connection", () => {
  it("answers a server request it does not handle with a JSON-RPC error so the turn cannot hang", async () => {
    const e = env();
    const script = [
      { request: { method: "item/permissions/requestApproval", params: { threadId: THREAD } } },
    ];
    const events = await run(make(e, script), task(e));
    const [reply] = replies(e);
    expect(reply).toMatchObject({ id: 100, error: { code: expect.any(Number) } });
    expect(reply).not.toHaveProperty("result");
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("declines once on timeout and never retries", async () => {
    const e = env();
    const a = make(e, [cmdRequest("git status")], {
      approvalTimeoutMs: 50,
      evaluate: () => new Promise(() => {}), // a decision that never arrives
    });
    const events = await run(a, task(e));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
    expect(denied(events)[0]?.reason).toMatch(/time/i);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("declines when the policy engine throws (fail-closed)", async () => {
    const e = env();
    const a = make(e, [cmdRequest("git status")], {
      evaluate: () => Promise.reject(new Error("engine down")),
    });
    await run(a, task(e));
    expect(replies(e)).toEqual([{ id: 100, result: { decision: "decline" } }]);
  });

  it("reports needsReconciliation when the server dies after turn/start", async () => {
    const e = env();
    const events = await run(make(e, [{ sleep: 20 }, { exit: 3 }]), task(e));
    expect(events.at(-1)).toMatchObject({ type: "error", needsReconciliation: true });
    expect(validateEventStream(events)).toEqual([]);
  });

  it("reports a plain error (no reconciliation) when codex cannot be started", async () => {
    const e = env();
    const a = make(e, [], { command: "definitely-not-a-real-codex-binary" });
    const events = await run(a, task(e));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "error" });
    expect(last).not.toHaveProperty("needsReconciliation");
  });

  it("cancels on abort and stops the server", async () => {
    const e = env();
    const ac = new AbortController();
    const a = make(e, [{ hang: true }]);
    const p = run(a, task(e, { signal: ac.signal }));
    setTimeout(() => ac.abort(), 300);
    const events = await p;
    expect(events.at(-1)).toMatchObject({ type: "error", message: "cancelled" });
  });
});
