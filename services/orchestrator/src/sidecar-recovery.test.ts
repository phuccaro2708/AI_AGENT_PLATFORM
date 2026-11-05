import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent, SidecarEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";
import type { RecoveryReport } from "./recovery.js";

/**
 * `mode` decides what the fake CLI does before the process is killed: start a tool and never see its
 * result (`tool`), only talk (`text`), or finish normally (`ok`, used after the restart).
 */
class Fake implements AgentAdapter {
  runs = 0;
  constructor(
    readonly id: string,
    private readonly mode: "tool" | "text" | "ok",
  ) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(_task: AgentTask): AsyncIterable<AgentEvent> {
    this.runs++;
    if (this.mode === "tool") {
      yield { type: "tool_call", name: "Bash", args: { command: "rm -rf build" }, callId: "c1" };
      await new Promise<void>(() => undefined); // the process dies here
    }
    yield { type: "text", content: "working" };
    if (this.mode === "text") await new Promise<void>(() => undefined);
    yield { type: "completed" };
  }
}

let dir: string;
let root: string;
let svc: SidecarService;
let events: SidecarEvent[];
let n = 0;
const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
const open = (adapters: Fake[]) =>
  new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      extraAdapters: adapters,
      worktreesDir: join(dir, "wt"),
      schedulerIntervalMs: 20,
      onEvent: (e) => events.push(e),
    },
    createLogger({ name: "t", destination: sink() }),
  );
const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
};
const stateOf = async (taskId: string) =>
  (await call<{ state: string }>("queryTask", { taskId })).state;
const attemptOf = (taskId: string) =>
  (
    svc.db.$client.prepare("select attempt from tasks where id=?").get(taskId) as {
      attempt: number;
    }
  ).attempt;

/** Starts a task with a fake that dies mid-run, "kills" the sidecar and restarts it on the same database. */
async function crashedTask(mode: "tool" | "text"): Promise<{ taskId: string; again: Fake }> {
  const dying = new Fake("fake", mode);
  svc = open([dying]);
  const { projectId } = await call<{ projectId: string }>("projects.create", {
    name: "p",
    rootPath: root,
  });
  const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
  const { taskId } = await call<{ taskId: string }>("workflows.start", {
    workflowId,
    agentId: "fake",
    prompt: "do it",
  });
  while (dying.runs === 0) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50)); // let the first event be stored
  expect(await stateOf(taskId)).toBe("running");
  svc.close(); // nothing ever settles the row: it stays running
  const again = new Fake("fake", "ok");
  svc = open([again]);
  return { taskId, again };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-recovery-"));
  events = [];
  root = join(dir, "project");
  mkdirSync(root);
  root = realpathSync.native(root);
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("recovery after the sidecar was killed mid-task", () => {
  it("moves a task with an unfinished tool to needs_reconciliation and does not retry it by itself", async () => {
    const { taskId, again } = await crashedTask("tool");
    await new Promise((r) => setTimeout(r, 300)); // several scheduler ticks
    expect(await stateOf(taskId)).toBe("needs_reconciliation");
    expect(again.runs).toBe(0);
    const report = await call<RecoveryReport>("recovery.inspect", { taskId });
    expect(report.classification).toBe("side_effects_unverified");
    expect(report.evidence).toMatchObject({ toolCalls: 1, unfinishedToolCalls: 1 });
    // inspect only reads
    expect(await stateOf(taskId)).toBe("needs_reconciliation");
    expect(again.runs).toBe(0);
  });

  it("refuses retry and resume without confirmation when side effects are unverified; abandon needs none", async () => {
    const { taskId, again } = await crashedTask("tool");
    for (const action of ["retry", "resume"]) {
      await expect(
        call("recovery.resolve", { taskId, action, note: "looked at it" }),
      ).rejects.toThrow(/without confirmation/);
    }
    expect(await stateOf(taskId)).toBe("needs_reconciliation");
    expect(again.runs).toBe(0);
    const r = await call<{ state: string }>("recovery.resolve", {
      taskId,
      action: "abandon",
      note: "build dir state unknown, giving up",
    });
    expect(r.state).toBe("cancelled");
    expect(again.runs).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "task.state", taskId, state: "cancelled" }),
    );
  });

  it("retry with confirmation requeues, raises attempt and only then runs the task again", async () => {
    const { taskId, again } = await crashedTask("tool");
    expect(attemptOf(taskId)).toBe(0);
    const r = await call<{ state: string }>("recovery.resolve", {
      taskId,
      action: "retry",
      note: "nothing was deleted",
      confirmUnverified: true,
    });
    expect(["queued", "running", "completed"]).toContain(r.state);
    expect(attemptOf(taskId)).toBe(1);
    for (let i = 0; i < 100 && (await stateOf(taskId)) !== "completed"; i++) {
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(await stateOf(taskId)).toBe("completed");
    expect(again.runs).toBe(1);
  });

  it("resume with confirmation settles the task as completed without running it", async () => {
    const { taskId, again } = await crashedTask("tool");
    const r = await call<{ state: string }>("recovery.resolve", {
      taskId,
      action: "resume",
      note: "output is usable",
      confirmUnverified: true,
    });
    expect(r.state).toBe("completed");
    expect(again.runs).toBe(0);
  });

  it("a task that only talked has no evidence of side effects: retry needs no confirmation", async () => {
    const { taskId } = await crashedTask("text");
    const report = await call<RecoveryReport>("recovery.inspect", { taskId });
    expect(report.classification).toBe("no_evidence_of_side_effects");
    expect(report.actions.retry).toMatchObject({ allowed: true, confirmation: false });
    await call("recovery.resolve", { taskId, action: "retry", note: "only text so far" });
    expect(attemptOf(taskId)).toBe(1);
  });

  it("refuses a task that is not waiting for reconciliation, an unknown task and a short note", async () => {
    const { taskId } = await crashedTask("tool");
    await call("recovery.resolve", { taskId, action: "abandon", note: "done with it" });
    await expect(
      call("recovery.resolve", { taskId, action: "abandon", note: "again please" }),
    ).rejects.toThrow(/not needs_reconciliation/);
    await expect(call("recovery.inspect", { taskId: "nope" })).rejects.toThrow(/Unknown task/);
    await expect(
      call("recovery.resolve", { taskId: "nope", action: "abandon", note: "abc" }),
    ).rejects.toThrow(/Unknown task/);
    await expect(
      call("recovery.resolve", { taskId, action: "abandon", note: " x " }),
    ).rejects.toThrow();
  });

  it("keeps an evidence summary in the audit trail", async () => {
    const { taskId } = await crashedTask("tool");
    await call("recovery.resolve", { taskId, action: "abandon", note: "checked, leaving it" });
    const last = JSON.stringify(
      events.filter((e) => e.event === "task.state" && e.taskId === taskId).at(-1),
    );
    expect(last).toContain("abandon (side_effects_unverified; tool calls 1, unfinished 1");
  });
});
