import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { ApprovalService } from "./approvals.js";

let dir: string;
let db: StudioDb;
let repo: Repo;
let wf: string;
let nowMs: number;
let svc: ApprovalService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-appr-"));
  db = openDatabase(join(dir, "test.db"));
  runMigrations(db);
  repo = new Repo(db);
  wf = repo.createWorkflow(repo.createProject("demo", "/p"));
  nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  svc = new ApprovalService({ repo, clock: () => new Date(nowMs), defaultTtlMs: 60_000 });
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const runningTask = () => {
  const t = repo.createTask(wf, "claude");
  repo.setTaskState(t, "running");
  return t;
};

describe("ApprovalService", () => {
  it("parks the task and records the request message in one step", () => {
    const t = runningTask();
    const id = svc.request(t, "merge branch X");
    expect(repo.getTaskState(t)).toBe("waiting_approval");
    expect(repo.listApprovals("pending").map((a) => a.id)).toEqual([id]);
    const msg = repo.listMessages(t).find((m) => m.type === "approval.request");
    expect(msg?.payload).toEqual({ approvalId: id, description: "merge branch X" });
  });

  it("refuses to park a task that is not running and leaves no approval behind", () => {
    const t = repo.createTask(wf, "claude"); // queued
    expect(() => svc.request(t, "x")).toThrow(/Illegal task transition/);
    expect(repo.listApprovals()).toHaveLength(0);
    expect(repo.listMessages(t)).toHaveLength(0);
  });

  it("approved resumes the task; the decision cannot be given twice", () => {
    const t = runningTask();
    const id = svc.request(t, "x");
    svc.resolve(id, "approved");
    expect(repo.getTaskState(t)).toBe("running");
    expect(() => svc.resolve(id, "denied")).toThrow(/not pending/);
    expect(repo.getTaskState(t)).toBe("running");
  });

  it("denied fails the task", () => {
    const t = runningTask();
    const id = svc.request(t, "x");
    svc.resolve(id, "denied", "too risky");
    expect(repo.getTaskState(t)).toBe("failed");
  });

  it("an overdue request cannot be answered, and expiring it needs reconciliation, never a retry", () => {
    const t = runningTask();
    const id = svc.request(t, "x", { ttlMs: 1000 });
    nowMs += 5000;
    expect(() => svc.resolve(id, "approved")).toThrow(/expired/);
    expect(repo.getTaskState(t)).toBe("waiting_approval");
    expect(svc.expireDue()).toEqual([id]);
    expect(repo.getTaskState(t)).toBe("needs_reconciliation");
    expect(svc.expireDue()).toEqual([]);
    expect(repo.listApprovals("pending")).toHaveLength(0);
  });

  it("does not touch a task that already left waiting_approval when its approval expires", () => {
    const t = runningTask();
    svc.request(t, "x", { ttlMs: 1000 });
    repo.setTaskState(t, "cancelled");
    nowMs += 5000;
    svc.expireDue();
    expect(repo.getTaskState(t)).toBe("cancelled");
  });

  it("an answer for a task that is no longer waiting changes nothing", () => {
    const t = runningTask();
    const id = svc.request(t, "x");
    repo.setTaskState(t, "cancelled");
    expect(() => svc.resolve(id, "approved")).toThrow(/Illegal task transition/);
    expect(repo.listApprovals("pending").map((a) => a.id)).toEqual([id]);
  });
});
