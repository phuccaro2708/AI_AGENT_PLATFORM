import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentCapability, AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

/** Completes with a text saying who ran it. */
class Fake implements AgentAdapter {
  constructor(
    readonly id: string,
    private readonly caps: AgentCapability[],
    private readonly available = true,
  ) {}
  async detect() {
    return this.available;
  }
  async capabilities() {
    return this.caps;
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    yield { type: "text", content: `${this.id}: ${task.prompt}` };
    yield { type: "completed" };
  }
}

let dir: string;
let svc: SidecarService | undefined;
let n = 0;

const call = async (method: string, params?: unknown) => {
  const { response } = await svc!.handle({ id: ++n, method, ...(params ? { params } : {}) });
  return response as { result?: Record<string, any>; error?: { message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

function open(extraAdapters: AgentAdapter[]) {
  svc = new SidecarService(
    { dbPath: join(dir, "s.db"), extraAdapters, schedulerIntervalMs: 20 },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
}

async function workflow() {
  const rootPath = join(dir, "proj");
  mkdirSync(rootPath, { recursive: true });
  const p = await call("projects.create", { name: "p", rootPath });
  const w = await call("workflows.create", { projectId: p.result?.["projectId"] });
  return w.result?.["workflowId"] as string;
}

const agentOf = async (taskId: unknown) =>
  (await call("tasks.history")).result?.["tasks"].find(
    (t: { taskId: string }) => t.taskId === taskId,
  )?.agentId;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-route-"));
  // Hermetic: the built-in claude/codex adapters look their CLI up on PATH. With an empty
  // PATH none is "available", so these tests can never start a real CLI on a developer machine.
  vi.stubEnv("PATH", dir);
});
afterEach(() => {
  svc?.close();
  svc = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("workflows.start without agentId (capability router)", () => {
  it("picks by capability, skipping an unavailable and a non-streaming agent registered earlier", async () => {
    open([
      new Fake("down", ["streaming"], false),
      new Fake("mute", []),
      new Fake("live", ["streaming"]),
    ]);
    // Precondition: no real CLI can be picked in this environment.
    const list = (await call("agents.list")).result?.["adapters"] as {
      id: string;
      available: boolean;
    }[];
    for (const id of ["claude", "codex"]) {
      expect(list.find((a) => a.id === id)?.available).toBe(false);
    }
    const workflowId = await workflow();
    const r = await call("workflows.start", { workflowId, prompt: "hi" });
    await svc!.idle();
    expect(r.error).toBeUndefined();
    expect(await agentOf(r.result?.["taskId"])).toBe("live");
    expect((await call("queryTask", { taskId: r.result?.["taskId"] })).result?.["state"]).toBe(
      "completed",
    );
  });

  it("fails with the capability gap in Vietnamese and starts nothing when no agent qualifies", async () => {
    open([new Fake("mute", [])]);
    const workflowId = await workflow();
    const r = await call("workflows.start", { workflowId, prompt: "hi" });
    expect(r.result).toBeUndefined();
    expect(r.error?.message).toContain("Không có agent phù hợp");
    expect(r.error?.message).toContain("mute không hỗ trợ: phát kết quả theo luồng");
    expect(r.error?.message).toContain("claude chưa cài hoặc không tìm thấy CLI");
    expect((await call("tasks.history")).result?.["tasks"]).toEqual([]);
    expect((await call("tasks.list", { workflowId })).result?.["tasks"]).toEqual([]);
  });

  it("never auto-picks the internal stub, even though it can stream", async () => {
    open([]);
    const workflowId = await workflow();
    const r = await call("workflows.start", { workflowId, prompt: "hi" });
    expect(r.error?.message).toContain("Không có agent phù hợp");
    expect(r.error?.message).not.toContain("stub");
  });

  it("still honours an explicit agentId, even one that declares no capabilities", async () => {
    open([new Fake("mute", [])]);
    const workflowId = await workflow();
    const r = await call("workflows.start", { workflowId, agentId: "mute", prompt: "hi" });
    await svc!.idle();
    expect(await agentOf(r.result?.["taskId"])).toBe("mute");
    const again = await call("workflows.start", { workflowId, agentId: "ghost", prompt: "x" });
    expect(again.error?.message).toMatch(/Unknown agent/);
  });
});
