import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real child process (a fake `codex app-server`) + SQLite: the whole suite runs in parallel, so allow more time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

/**
 * P4-1 c wired into the orchestrator: the `codex-app-server` agent is registered only on request, runs inside the
 * PolicyGate, and answers Codex's approval requests through the Policy Engine. The server is a FAKE
 * (packages/adapter-codex/test/fake-app-server.mjs); NO real Codex is run here.
 */
const fake = fileURLToPath(
  new URL("../../../packages/adapter-codex/test/fake-app-server.mjs", import.meta.url),
);
const THREAD = "thr-1";

let dir: string;
let logFile: string;
let svc: SidecarService | undefined;
let n = 0;

function open(
  script: unknown[] | undefined,
  extra: Partial<ConstructorParameters<typeof SidecarService>[0]> = {},
) {
  svc = new SidecarService(
    {
      dbPath: join(dir, "data", "s.db"),
      worktreesDir: join(dir, "wt"),
      schedulerIntervalMs: 20,
      probes: {},
      ...(script
        ? {
            codexAppServer: {
              command: process.execPath,
              baseArgs: [fake],
              env: { ...process.env, FAKE_LOG: logFile, FAKE_SCRIPT: JSON.stringify(script) },
              envAllow: ["FAKE_LOG", "FAKE_SCRIPT"],
            },
          }
        : {}),
      ...extra,
    },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
  return svc;
}

type Rpc = { result?: Record<string, unknown>; error?: { message: string } };
const rpc = async (method: string, params?: unknown): Promise<Rpc> => {
  const { response } = await svc!.handle({ id: ++n, method, ...(params ? { params } : {}) });
  return response as Rpc;
};
const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const r = await rpc(method, params);
  if (r.error) throw new Error(r.error.message);
  return r.result as T;
};

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "as-cas-")));
  mkdirSync(join(dir, "data"));
  logFile = join(dir, "traffic.jsonl");
});
afterEach(() => {
  svc?.close();
  svc = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function run(root: string, agentId = "codex-app-server") {
  const { projectId } = await call<{ projectId: string }>("projects.create", {
    name: "p",
    rootPath: root,
  });
  const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
  await call("workflows.start", { workflowId, agentId, prompt: "do the thing" });
  await svc!.idle();
  const { tasks } = await call<{ tasks: { id: string; state: string }[] }>("tasks.list", {
    workflowId,
  });
  return tasks;
}

const decisions = (): unknown[] =>
  readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { method?: string; result?: { decision?: string } })
    .filter((m) => m.method === undefined && m.result?.decision !== undefined)
    .map((m) => m.result!.decision);

const commandRequest = (command: string) => ({
  request: {
    method: "item/commandExecution/requestApproval",
    params: {
      kind: "command",
      threadId: THREAD,
      turnId: "turn-1",
      itemId: "exec-1",
      command,
      cwd: "<cwd>",
      availableDecisions: ["accept", "cancel"],
    },
  },
});
const fileChange = (path: string) => [
  {
    notify: {
      method: "item/started",
      params: {
        threadId: THREAD,
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "fc-1",
          status: "inProgress",
          changes: [{ path, kind: { type: "add" }, diff: "x\n" }],
        },
      },
    },
  },
  {
    request: {
      method: "item/fileChange/requestApproval",
      params: { threadId: THREAD, turnId: "turn-1", itemId: "fc-1", reason: null, grantRoot: null },
    },
  },
];

function project(): string {
  const root = join(dir, "proj");
  mkdirSync(root, { recursive: true });
  return root;
}

describe("codex-app-server in the orchestrator (fake server)", () => {
  it("is NOT registered when switched off (codexAppServer:false); it is on by default since Q3", async () => {
    open(undefined, { codexAppServer: false });
    const { projectId } = await call<{ projectId: string }>("projects.create", {
      name: "p",
      rootPath: project(),
    });
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    const r = await rpc("workflows.start", {
      workflowId,
      agentId: "codex-app-server",
      prompt: "p",
    });
    expect(r.error?.message).toMatch(/Unknown agent/);
  });

  it("declines a command: no command is on the allow list, and the task still completes", async () => {
    open([commandRequest("git status")]);
    const tasks = await run(project());
    expect(decisions()).toEqual(["decline"]);
    expect(tasks.map((t) => t.state)).toEqual(["completed"]);
  });

  it("accepts a file write inside the project folder", async () => {
    const root = project();
    open(fileChange(join(root, "new.txt")));
    const tasks = await run(root);
    expect(decisions()).toEqual(["accept"]);
    expect(tasks.map((t) => t.state)).toEqual(["completed"]);
  });

  it("declines a file write outside the project folder", async () => {
    open(fileChange(join(dir, "outside.txt")));
    await run(project());
    expect(decisions()).toEqual(["decline"]);
  });

  it("fails closed when the Policy Engine throws: the approval is declined", async () => {
    const root = project();
    open(fileChange(join(root, "new.txt")), {
      policyEvaluate: ((_policy: unknown, request: { kind: string; path?: string }) => {
        // Preflight (project root, cwd) must pass; only the approval request itself breaks.
        if (request.kind === "fs.write" && request.path?.endsWith("new.txt")) {
          throw new Error("engine down");
        }
        return Promise.resolve({ effect: "allow", code: "test", reason: "test" });
      }) as unknown as NonNullable<
        ConstructorParameters<typeof SidecarService>[0]["policyEvaluate"]
      >,
    });
    await run(root);
    expect(decisions()).toEqual(["decline"]);
  });
});
