import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "@agent-studio/orchestrator";
import { startFakeOllama, type FakeOllama } from "./fake-ollama.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const quiet = createLogger({
  name: "t",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

let dir: string;
let svc: SidecarService | undefined;
let n = 0;
const servers: FakeOllama[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});
const call = async (method: string, params?: unknown) => {
  const { response } = await svc!.handle({ id: ++n, method, ...(params ? { params } : {}) });
  return response as { result?: Record<string, any>; error?: { message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-ollama-"));
});
afterEach(() => {
  svc?.close();
  svc = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const open = (ollama?: { baseUrl: string; model?: string }) => {
  vi.stubEnv("PATH", dir); // no real CLI can be found (only in tests that open a sidecar; git tests need PATH)
  svc = new SidecarService(
    { dbPath: join(dir, "s.db"), schedulerIntervalMs: 20, ...(ollama ? { ollama } : {}) },
    quiet,
  );
};
async function workflow() {
  const rootPath = join(dir, "proj");
  mkdirSync(rootPath, { recursive: true });
  const p = await call("projects.create", { name: "p", rootPath });
  const w = await call("workflows.create", { projectId: p.result?.["projectId"] });
  return w.result?.["workflowId"] as string;
}
const adapters = async () =>
  (await call("agents.list")).result?.["adapters"] as {
    id: string;
    available: boolean;
    capabilities: string[];
  }[];

describe("the ollama agent inside the sidecar (S3)", () => {
  it("is registered but unavailable until a model is configured", async () => {
    open();
    expect((await adapters()).find((a) => a.id === "ollama")).toMatchObject({
      available: false,
      capabilities: ["streaming"],
    });
  });

  it("runs a task end to end through the unchanged core and stores the streamed text", async () => {
    const s = await startFakeOllama("ok");
    servers.push(s);
    open({ baseUrl: s.url, model: "m" });
    expect((await adapters()).find((a) => a.id === "ollama")?.available).toBe(true);

    const workflowId = await workflow();
    const r = await call("workflows.start", { workflowId, agentId: "ollama", prompt: "hi" });
    expect(r.error).toBeUndefined();
    await svc!.idle();
    const taskId = r.result?.["taskId"];
    expect((await call("queryTask", { taskId })).result?.["state"]).toBe("completed");
    expect((await call("queryTask", { taskId })).result?.["messageCount"]).toBeGreaterThan(0);
    expect(s.chats).toHaveLength(1);
  });

  it("reports an unreachable server as a failed task, not a hang", async () => {
    open({ baseUrl: "http://127.0.0.1:1", model: "m" });
    // detect() is false, so the explicit agent is refused up front or fails; either way nothing runs forever
    const workflowId = await workflow();
    const r = await call("workflows.start", { workflowId, agentId: "ollama", prompt: "hi" });
    await svc!.idle();
    if (r.error) expect(r.error.message).toBeTruthy();
    else
      expect((await call("queryTask", { taskId: r.result?.["taskId"] })).result?.["state"]).toBe(
        "failed",
      );
  });
});

describe("Ollama's own VRAM figure in resources.get (S4)", () => {
  it("lists the loaded models with the scope named, and keeps it apart from the GPU reading", async () => {
    const s = await startFakeOllama("ok");
    servers.push(s);
    open({ baseUrl: s.url, model: "m" });
    const r = (await call("resources.get")).result!;
    expect(r.status.ollama).toEqual({
      scope: "ollama-models",
      models: [
        {
          name: "m:latest",
          sizeBytes: 9_400_000_000,
          sizeVramBytes: 6_000_000_000,
          contextLength: 4096,
        },
      ],
    });
    expect(r.status.gpu).toBeNull(); // no resource source in this sidecar: the GPU is a separate reading
  });

  it("is null when Ollama is down, answers an error, or says something else; never throws", async () => {
    open({ baseUrl: "http://127.0.0.1:1", model: "m" });
    expect((await call("resources.get")).result!.status.ollama).toBeNull();
    svc?.close();
    const s = await startFakeOllama("ok");
    servers.push(s);
    s.ps = undefined; // HTTP 500
    open({ baseUrl: s.url, model: "m" });
    expect((await call("resources.get")).result!.status.ollama).toBeNull();
    s.ps = { models: "nope" };
    expect((await call("resources.get")).result!.status.ollama).toBeNull();
    s.ps = { models: [{ name: "x" }, { name: "ok", size: 1, size_vram: 0 }] }; // the malformed row is skipped
    expect((await call("resources.get")).result!.status.ollama).toEqual({
      scope: "ollama-models",
      models: [{ name: "ok", sizeBytes: 1, sizeVramBytes: 0 }],
    });
  });

  it("is not asked at all when no model is configured (opt-in)", async () => {
    const s = await startFakeOllama("ok");
    servers.push(s);
    open({ baseUrl: s.url });
    expect((await call("resources.get")).result!.status.ollama).toBeNull();
  });
});

/**
 * "Adding an adapter does not change the core" (ROADMAP Phase 3 gate). Two checks:
 *  1. timeless: no core file mentions Ollama; only the wiring (`sidecar.ts`, `sidecar-main.ts`,
 *     `ollama-config.ts`) and the package itself do;
 *  2. historical: since the commit before the adapter work, git shows no change in the core files.
 */
const CORE_FILES = [
  "packages/agent-core/src/adapter.ts",
  "packages/agent-core/src/registry.ts",
  "packages/agent-core/src/contract.ts",
  "packages/agent-core/src/stub-adapter.ts",
  "services/orchestrator/src/orchestrator.ts",
  "services/orchestrator/src/scheduler.ts",
  "services/orchestrator/src/workflow-engine.ts",
  "services/orchestrator/src/capability-router.ts",
  "services/orchestrator/src/router.ts",
  "services/orchestrator/src/recovery.ts",
  "services/orchestrator/src/policy-gate.ts",
];

describe("adding the ollama adapter did not change the core", () => {
  it("no core file mentions ollama", () => {
    for (const f of CORE_FILES) {
      expect(readFileSync(join(repo, f), "utf8").toLowerCase(), f).not.toContain("ollama");
    }
  });

  it("the adapter package depends only on agent-core and contracts", () => {
    const pkg = JSON.parse(
      readFileSync(join(repo, "packages/adapter-ollama/package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@agent-studio/agent-core",
      "@agent-studio/contracts",
    ]);
  });

  // S0 ended at this commit; the adapter work starts right after it.
  const BASE = "1e88cd8";
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  const haveBase = (() => {
    try {
      git("cat-file", "-e", `${BASE}^{commit}`);
      return true;
    } catch {
      return false; // shallow clone or another checkout: this proof is not available there
    }
  })();

  it.skipIf(!haveBase)("git shows no change in the core files since the adapter work began", () => {
    expect(git("diff", "--name-only", BASE, "--", ...CORE_FILES)).toBe("");
  });

  it.skipIf(!haveBase)(
    "the agent contract (events, capabilities, task input) is textually unchanged",
    () => {
      const block = (text: string, name: string) => {
        const start = text.indexOf(`export const ${name} =`);
        return text.slice(start, text.indexOf("\nexport type", start));
      };
      const before = git("show", `${BASE}:packages/contracts/src/index.ts`);
      const after = readFileSync(join(repo, "packages/contracts/src/index.ts"), "utf8");
      for (const name of ["AgentCapability", "AgentEvent", "AgentTaskInput", "TaskState"]) {
        expect(block(after, name).length, name).toBeGreaterThan(20);
        expect(block(after, name), name).toBe(block(before, name));
      }
    },
  );
});
