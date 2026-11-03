import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { ApprovalCenter } from "./approvals.js";

let dir: string;
let db: StudioDb;
let repo: Repo;
let wf: string;
let clock: number;
let center: ApprovalCenter;

const req = { kind: "shell", summary: "run rm -rf build", detail: { cmd: ["rm", "-rf", "build"] } };
const runningTask = () => {
  const id = repo.createTask(wf, "claude");
  repo.setTaskState(id, "running", { leaseExpiresAt: new Date(clock + 60_000).toISOString() });
  return id;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-appr-"));
  db = openDatabase(join(dir, "a.db"));
  runMigrations(db);
  repo = new Repo(db);
  wf = repo.createWorkflow(repo.createProject("p", "/p"));
  clock = Date.parse("2026-01-01T00:00:00.000Z");
  center = new ApprovalCenter(repo, { ttlMs: 1000, now: () => new Date(clock) });
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ApprovalCenter", () => {
  it("parks the task in waiting_approval and lists the request for a human", () => {
    const t = runningTask();
    const { id } = center.request(t, req);
    expect(repo.getTaskState(t)).toBe("waiting_approval");
    expect(center.listPending()).toMatchObject([{ id, taskId: t, request: req }]);
    expect(repo.listMessages(t).at(-1)).toMatchObject({
      type: "approval.request",
      toAgent: "orchestrator",
    });
  });

  it("approve wakes the waiter, resumes the task with a fresh lease and logs who decided", async () => {
    const t = runningTask();
    const { id, decision } = center.request(t, req);
    expect(center.resolve(id, "approved", "user:alice", "looks fine")).toBe(true);
    await expect(decision).resolves.toBe("approved");
    expect(repo.getTaskState(t)).toBe("running");
    expect(repo.getTask(t)?.leaseExpiresAt).not.toBeNull();
    expect(repo.getApproval(id)).toMatchObject({
      state: "approved",
      resolvedBy: "user:alice",
      reason: "looks fine",
    });
    expect(repo.listEvents(id).map((e) => e.eventType)).toEqual([
      "approval.requested",
      "approval.resolved",
    ]);
  });

  it("deny also resumes the task (the agent is told no, not killed)", async () => {
    const t = runningTask();
    const { id, decision } = center.request(t, req);
    center.resolve(id, "denied", "user:alice");
    await expect(decision).resolves.toBe("denied");
    expect(repo.getTaskState(t)).toBe("running");
  });

  it("the first answer wins; a second resolve is rejected", () => {
    const { id } = center.request(runningTask(), req);
    expect(center.resolve(id, "denied", "user:a")).toBe(true);
    expect(center.resolve(id, "approved", "user:b")).toBe(false);
    expect(repo.getApproval(id)?.state).toBe("denied");
    expect(center.resolve("nope", "approved", "user:a")).toBe(false);
  });

  it("a late approval is recorded as expired and authorises nothing", async () => {
    const { id, decision } = center.request(runningTask(), req);
    clock += 1001;
    expect(center.resolve(id, "approved", "user:alice")).toBe(true);
    await expect(decision).resolves.toBe("expired");
    expect(repo.getApproval(id)).toMatchObject({ state: "expired", resolvedBy: "system:expired" });
  });

  it("expireDue expires only overdue requests", async () => {
    const a = center.request(runningTask(), req);
    clock += 500;
    const b = center.request(runningTask(), req);
    clock += 600; // a is 1100 old, b is 600 old
    expect(center.expireDue()).toEqual([a.id]);
    await expect(a.decision).resolves.toBe("expired");
    expect(repo.getApproval(b.id)?.state).toBe("pending");
  });

  it("only a running task can ask; denying a cancelled task's request leaves the task cancelled", () => {
    const queued = repo.createTask(wf, "claude");
    expect(() => center.request(queued, req)).toThrow();
    expect(repo.listPendingApprovals()).toEqual([]);

    const t = runningTask();
    const { id } = center.request(t, req);
    repo.setTaskState(t, "cancelled");
    expect(center.cancelForTask(t)).toEqual([id]);
    expect(repo.getTaskState(t)).toBe("cancelled");
  });

  it("restart recovery expires open requests so an old yes cannot resurrect the task", () => {
    const t = runningTask();
    const { id } = center.request(t, req);
    expect(repo.recoverInterruptedTasks()).toEqual([t]);
    expect(repo.getApproval(id)).toMatchObject({ state: "expired", resolvedBy: "system:restart" });
    expect(center.resolve(id, "approved", "user:alice")).toBe(false);
    expect(repo.getTaskState(t)).toBe("needs_reconciliation");
  });
});
