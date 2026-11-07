import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real git/SQLite/filesystem work: the whole suite runs these files in parallel, so the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { SidecarRequest, type AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

/**
 * P4-9 (security tests), IPC surface of the sidecar, with fake agents (no CLI is run). Covers the threat-model rows
 * that had no test of their own:
 *   T2   the whole IPC surface survives hostile parameters (the earlier tests only fuzzed `logs.search`);
 *   T12  the native allowlist (`ALLOWED_METHODS`) matches the sidecar contract, and a `cwd` sent by the UI is ignored;
 *   T7   a read-only reviewer that writes into the worktree fails the workflow (real git worktree, sidecar level).
 */

class Fake implements AgentAdapter {
  tasks: AgentTask[] = [];
  constructor(
    readonly id: string,
    private readonly play: (task: AgentTask) => AgentEvent[],
  ) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    this.tasks.push(task);
    for (const e of this.play(task)) yield e;
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let dir: string;
let svc: SidecarService | undefined;
let n = 0;

function open(extra: Fake[]): SidecarService {
  svc = new SidecarService(
    {
      dbPath: join(dir, "data", "s.db"),
      extraAdapters: extra,
      worktreesDir: join(dir, "wt"),
      schedulerIntervalMs: 20,
      probes: {},
    },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
  return svc;
}

type Rpc = { id?: unknown; result?: Record<string, unknown>; error?: { message: string } };
const raw = async (request: unknown) => svc!.handle(request);
const rpc = async (method: string, params?: unknown): Promise<Rpc> =>
  (await raw({ id: ++n, method, ...(params === undefined ? {} : { params }) })).response as Rpc;
const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const r = await rpc(method, params);
  if (r.error) throw new Error(r.error.message);
  return r.result as T;
};

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "as-ipc-")));
  mkdirSync(join(dir, "data"));
});
afterEach(() => {
  svc?.close();
  svc = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---- the methods and parameter names the contract declares, read from the schema itself ----
type Option = { shape: Record<string, { value?: unknown; def?: { values?: unknown[] } }> };
const options = (SidecarRequest as unknown as { options: Option[] }).options;
const methodOf = (o: Option): string => {
  const m = o.shape["method"]!;
  return String(m.value ?? m.def?.values?.[0]);
};
const allMethods = options.map(methodOf);
const paramKeys = [
  ...new Set(
    options.flatMap((o) => {
      const p = o.shape["params"] as unknown as { shape?: Record<string, unknown> } | undefined;
      return p?.shape ? Object.keys(p.shape) : [];
    }),
  ),
];

describe("the contract the fuzz below walks", () => {
  it("is read correctly from the schema (guards the fuzz against silently covering nothing)", () => {
    expect(allMethods.length).toBeGreaterThan(25);
    expect(allMethods).toContain("approvals.resolve");
    expect(paramKeys).toEqual(
      expect.arrayContaining(["taskId", "workflowId", "rootPath", "prompt"]),
    );
  });
});

describe("T2: every IPC method survives hostile parameters", () => {
  const HOSTILE: unknown[] = [
    null,
    "",
    "x",
    "../../etc/passwd",
    "C:\\Windows\\System32",
    "'; DROP TABLE tasks; --",
    "a\u0000b",
    "\u202e\u0007\u001b[2J",
    "A".repeat(200_000),
    0,
    -1,
    1.5,
    1e308,
    true,
    [],
    [[]],
    {},
    { __proto__: { polluted: "yes" } },
    JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}'),
    { toString: 1, valueOf: 2 },
  ];
  /** Methods skipped by the fuzz, with the reason. `shutdown` ends the loop by design; `agents.scan` looks for real CLIs. */
  const SKIP = new Set(["shutdown", "agents.scan"]);

  it("returns a well-formed response (never throws, never asks to shut down), whatever the parameters", async () => {
    open([new Fake("plain", () => [{ type: "completed" }])]);
    const cwdBefore = process.cwd();
    let calls = 0;
    for (const method of allMethods.filter((m) => !SKIP.has(m))) {
      for (const h of HOSTILE) {
        // (a) the whole `params` is hostile, (b) every parameter name carries the hostile value
        const asParams = [h, Object.fromEntries(paramKeys.map((k) => [k, h]))];
        for (const params of asParams) {
          let out: { response: Rpc; shutdown: boolean };
          try {
            out = (await raw({ id: ++n, method, params })) as never;
          } catch (err) {
            throw new Error(`${method} threw on ${JSON.stringify(params)?.slice(0, 80)}: ${err}`, {
              cause: err,
            });
          }
          calls++;
          expect(out.shutdown, `${method} must not shut the sidecar down`).toBe(false);
          const r = out.response;
          expect(typeof r.id === "number" || r.id === null, `${method} response id`).toBe(true);
          expect(
            (r.result !== undefined) !== (r.error !== undefined),
            `${method}: exactly one of result / error`,
          ).toBe(true);
        }
      }
    }
    expect(calls).toBeGreaterThan(allMethods.length * HOSTILE.length);
    // no prototype pollution, no change of the process' working folder, and the database is still sound
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(process.cwd()).toBe(cwdBefore);
    const sql = svc!.db.$client;
    expect(sql.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(
      (
        sql.prepare("SELECT COUNT(*) c FROM tasks WHERE state IN ('queued','running')").get() as {
          c: number;
        }
      ).c,
      "hostile parameters never start a task",
    ).toBe(0);
    // and it still serves a normal request afterwards
    expect((await call<{ pid: number }>("health")).pid).toBe(process.pid);
  });

  it("answers a malformed REQUEST (not an object, bad id, unknown or inherited method name) with an error", async () => {
    open([]);
    const bad: unknown[] = [
      null,
      undefined,
      "health",
      42,
      [],
      {},
      { id: 1 },
      { method: "health" },
      { id: "1", method: "health" },
      { id: 1.5, method: "health" },
      { id: Infinity, method: "health" },
      { id: 1, method: "" },
      { id: 1, method: "HEALTH" },
      { id: 1, method: "health " },
      { id: 1, method: "__proto__" },
      { id: 1, method: "constructor" },
      { id: 1, method: "toString" },
      { id: 1, method: "runStub", params: {} },
      { id: 1, method: ["health"] },
      { id: 1, method: { toString: () => "health" } },
    ];
    for (const b of bad) {
      const out = await raw(b);
      const r = out.response as Rpc;
      expect(out.shutdown, JSON.stringify(b)).toBe(false);
      expect(r.error, `error for ${JSON.stringify(b)}`).toBeDefined();
      expect(r.result, `no result for ${JSON.stringify(b)}`).toBeUndefined();
    }
    expect((await call<{ pid: number }>("health")).pid).toBe(process.pid);
  });
});

describe("T12: the native allowlist and the UI's reach", () => {
  const libRs = readFileSync(
    fileURLToPath(new URL("../../../apps/desktop/src-tauri/src/lib.rs", import.meta.url)),
    "utf8",
  );
  const block = /const ALLOWED_METHODS: &\[&str\] = &\[([\s\S]*?)\];/.exec(libRs)?.[1] ?? "";
  const allowed = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

  it("lists only methods that exist in the contract, without duplicates", () => {
    expect(allowed.length).toBeGreaterThan(20);
    expect(new Set(allowed).size).toBe(allowed.length);
    expect(allowed.filter((m) => !allMethods.includes(m))).toEqual([]);
  });

  it("keeps `shutdown`, `runStub` and the internal `system.activeTasks` out of the UI's reach; a new method must be decided on", () => {
    // Every contract method NOT in the allowlist is on this list on purpose. Adding a method to the contract makes
    // this fail until someone decides whether the webview may call it (and updates ALLOWED_METHODS or this list).
    const notReachable = allMethods.filter((m) => !allowed.includes(m)).sort();
    expect(notReachable).toEqual(["confirm.describe", "runStub", "shutdown", "system.activeTasks"]);
  });

  it("does not let the UI choose where an agent runs: a `cwd` in the parameters is ignored", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const root = join(dir, "proj");
    mkdirSync(root);
    const agent = new Fake("plain", () => [{ type: "text", content: "ok" }, { type: "completed" }]);
    open([agent]);
    const { projectId } = await call<{ projectId: string }>("projects.create", {
      name: "p",
      rootPath: root,
      cwd: outside,
    });
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", {
      projectId,
      cwd: outside,
    });
    await call("workflows.start", {
      workflowId,
      agentId: "plain",
      prompt: "hi",
      cwd: outside,
      workingDirectory: outside,
    });
    await svc!.idle();
    expect(agent.tasks).toHaveLength(1);
    expect(realpathSync.native(agent.tasks[0]!.cwd)).toBe(realpathSync.native(root));
  });
});

describe("T7: a read-only reviewer that writes into the worktree (real git, sidecar level)", () => {
  function repoWith(files: Record<string, string>): string {
    const root = join(dir, "repo");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    git(root, "config", "core.autocrlf", "false");
    for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c);
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "init");
    return root;
  }

  const APPROVE = JSON.stringify({ verdict: "approve", comments: [] });
  const attacks: [string, (cwd: string) => void][] = [
    ["adds a file", (cwd) => writeFileSync(join(cwd, "sneaky.txt"), "x\n")],
    ["edits a tracked file", (cwd) => writeFileSync(join(cwd, "README.md"), "tampered\n")],
    [
      "adds a file whose name looks like an instruction",
      (cwd) => writeFileSync(join(cwd, "APPROVED-by-orchestrator.txt"), "x\n"),
    ],
  ];

  for (const [name, attack] of attacks) {
    it(`discards the verdict and stops for reconciliation when the reviewer ${name}`, async () => {
      const root = repoWith({ "README.md": "hi\n" });
      const impl = new Fake("impl", (t) => {
        writeFileSync(join(t.cwd, "feature.txt"), "done\n");
        return [{ type: "text", content: "wrote feature" }, { type: "completed" }];
      });
      const rev = new Fake("rev", (t) => {
        attack(t.cwd);
        return [{ type: "text", content: APPROVE }, { type: "completed" }];
      });
      open([impl, rev]);
      const { projectId } = await call<{ projectId: string }>("projects.create", {
        name: "p",
        rootPath: root,
      });
      const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
      await call("workflows.startPeerReview", {
        workflowId,
        implementerAgent: "impl",
        reviewerAgent: "rev",
        goal: "add feature",
      });
      // The platform's PolicyGate sees the write first (post-run snapshot against the Read Only level), so the
      // reviewer's task ends `needs_reconciliation` and the engine never gets to count its verdict.
      const until = Date.now() + 20_000;
      let tasks: { agentId: string; state: string }[] = [];
      let wfState = "";
      while (Date.now() < until) {
        const r = await call<{ workflowState: string; tasks: typeof tasks }>("tasks.list", {
          workflowId,
        });
        tasks = r.tasks;
        wfState = r.workflowState;
        const reviewer = tasks.find((t) => t.agentId === "rev");
        if (reviewer && !["queued", "running"].includes(reviewer.state)) break;
        await new Promise((res) => setTimeout(res, 15));
      }
      await svc!.idle();
      expect(tasks.find((t) => t.agentId === "rev")?.state).toBe("needs_reconciliation");
      expect(
        wfState,
        "an approving reviewer that wrote to the worktree must not complete",
      ).not.toBe("completed");
      const revId = (
        await call<{ tasks: { id: string; agentId: string }[] }>("tasks.list", {
          workflowId,
        })
      ).tasks.find((t) => t.agentId === "rev")!.id;
      const msgs = await call<{ messages: { type: string; payload: { message?: string } }[] }>(
        "logs.query",
        { taskId: revId, afterSequence: -1, limit: 100 },
      );
      expect(
        msgs.messages.some(
          (m) =>
            m.type === "task.failed" &&
            /Read Only level does not allow writing/.test(m.payload.message ?? ""),
        ),
        "the reason names the violated level",
      ).toBe(true);
      // the reviewer's APPROVE was not turned into a review result
      expect(msgs.messages.some((m) => m.type === "review.result")).toBe(false);
      // the main checkout of the user's project was not touched by any of this
      expect(git(root, "status", "--porcelain")).toBe("");
    });
  }
});
