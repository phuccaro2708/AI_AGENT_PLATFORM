import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

/**
 * P4-4 (b) wired into the orchestrator: `jobWrap` reaches the `claude` and `codex` spawns. No real CLI and no real
 * wrapper are run: an unusable wrapper path makes the run fail closed, which only happens if the option got there.
 */
let dir: string;
let svc: SidecarService | undefined;
let n = 0;

function open(extra: Partial<ConstructorParameters<typeof SidecarService>[0]>) {
  svc = new SidecarService(
    {
      dbPath: join(dir, "data", "s.db"),
      worktreesDir: join(dir, "wt"),
      schedulerIntervalMs: 20,
      probes: {},
      ...extra,
    },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
}
type Rpc = { result?: Record<string, unknown>; error?: { message: string } };
const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc!.handle({ id: ++n, method, ...(params ? { params } : {}) });
  const r = response as Rpc;
  if (r.error) throw new Error(r.error.message);
  return r.result as T;
};

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "as-jw-")));
  mkdirSync(join(dir, "data"));
});
afterEach(() => {
  svc?.close();
  svc = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function messagesOf(agentId: string): Promise<string> {
  const root = join(dir, "proj");
  mkdirSync(root, { recursive: true });
  const { projectId } = await call<{ projectId: string }>("projects.create", {
    name: "p",
    rootPath: root,
  });
  const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
  await call("workflows.start", { workflowId, agentId, prompt: "go" });
  await svc!.idle();
  const { tasks } = await call<{ tasks: { id: string; state: string }[] }>("tasks.list", {
    workflowId,
  });
  expect(tasks.map((t) => t.state)).toEqual(["failed"]);
  const out = await call("logs.query", { taskId: tasks[0]!.id, afterSequence: 0, limit: 100 });
  return JSON.stringify(out);
}

describe("jobWrap in the orchestrator", () => {
  it.each(["claude", "codex"])(
    "%s: an unusable wrapper path stops the run and names the wrapper",
    async (agentId) => {
      open({ jobWrap: { path: "relative/agent-job-wrap.exe" } });
      expect(await messagesOf(agentId)).toContain("agent-job-wrap");
    },
  );
});
