import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Writable } from "node:stream";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

/**
 * P4-4 (b) wired into the orchestrator: `jobWrap` reaches the `claude` and `codex` spawns. No real CLI and no real
 * wrapper are run: an unusable wrapper path makes the run fail closed, which only happens if the option got there.
 * The adapters look the program up on PATH before they check these options, so empty placeholder programs named
 * `claude` and `codex` are put first on PATH (a CI runner has neither CLI). They are never started.
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
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["claude", "codex"]) {
    const file = join(bin, process.platform === "win32" ? `${name}.exe` : name);
    writeFileSync(file, "");
    if (process.platform !== "win32") chmodSync(file, 0o755);
  }
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env["PATH"] ?? ""}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
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

describe("cliTreeMemoryLimitMb in the orchestrator", () => {
  it.each(["claude", "codex"])(
    "%s: the option reaches the spawn (an invalid value stops the run and names it)",
    async (agentId) => {
      // The codex app-server checks the limit right after the spawn, so it needs a program that really starts:
      // node itself (it exits on the unknown arguments; the run has already been stopped by then).
      open({
        cliTreeMemoryLimitMb: 0,
        ...(agentId === "codex" ? { codexAppServer: { command: process.execPath } } : {}),
      });
      expect(await messagesOf(agentId)).toContain("treeMemoryLimitMb");
    },
  );
});

describe("jobWrap in the orchestrator", () => {
  it.each(["claude", "codex"])(
    "%s: an unusable wrapper path stops the run and names the wrapper",
    async (agentId) => {
      open({ jobWrap: { path: "relative/agent-job-wrap.exe" } });
      expect(await messagesOf(agentId)).toContain("agent-job-wrap");
    },
  );
});
