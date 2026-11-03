import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DependencyCycleError, openDatabase, runMigrations, Repo, type StudioDb } from "./index.js";

let dir: string;
let db: StudioDb;
let repo: Repo;
let wf: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-p2-"));
  db = openDatabase(join(dir, "test.db"));
  runMigrations(db);
  repo = new Repo(db);
  wf = repo.createWorkflow(repo.createProject("demo", "/p"));
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha = "a".repeat(64);

describe("task dependencies", () => {
  it("lists dependencies and rejects self, direct and transitive cycles", () => {
    const [a, b, c] = [repo.createTask(wf), repo.createTask(wf), repo.createTask(wf)] as [
      string,
      string,
      string,
    ];
    repo.addDependency(b, a); // b waits for a
    repo.addDependency(c, b);
    expect(repo.listDependencies(c)).toEqual([b]);
    expect(() => repo.addDependency(a, a)).toThrow(DependencyCycleError);
    expect(() => repo.addDependency(a, b)).toThrow(DependencyCycleError);
    expect(() => repo.addDependency(a, c)).toThrow(DependencyCycleError);
    expect(repo.listDependencies(a)).toEqual([]);
  });

  it("adding the same dependency twice is a no-op", () => {
    const a = repo.createTask(wf);
    const b = repo.createTask(wf);
    repo.addDependency(b, a);
    repo.addDependency(b, a);
    expect(repo.listDependencies(b)).toEqual([a]);
  });
});

describe("ready set, claim and lease", () => {
  it("ready = queued with every dependency completed, by priority then age", () => {
    const a = repo.createTask(wf);
    const b = repo.createTask(wf, undefined, { priority: 5 });
    const c = repo.createTask(wf, undefined, { priority: 9 });
    repo.addDependency(c, a);
    expect(repo.listReadyTasks(10)).toEqual([b, a]);
    repo.setTaskState(a, "running");
    repo.setTaskState(a, "completed");
    expect(repo.listReadyTasks(10)).toEqual([c, b]);
    expect(repo.listReadyTasks(1)).toEqual([c]);
  });

  it("a dependency that is failed or cancelled blocks; needs_reconciliation only waits", () => {
    const a = repo.createTask(wf);
    const b = repo.createTask(wf);
    const x = repo.createTask(wf);
    const y = repo.createTask(wf);
    repo.addDependency(x, a);
    repo.addDependency(y, b);
    repo.setTaskState(a, "running");
    repo.setTaskState(a, "failed");
    repo.setTaskState(b, "running");
    repo.setTaskState(b, "needs_reconciliation");
    expect(repo.listTasksBlockedByFailure()).toEqual([x]);
    expect(repo.listReadyTasks(10)).not.toContain(x);
    expect(repo.listReadyTasks(10)).not.toContain(y);
  });

  it("claim is atomic: only a queued task can be claimed, once", () => {
    const t = repo.createTask(wf);
    expect(repo.claimTask(t, "2026-01-01T00:01:00.000Z")).toBe(true);
    expect(repo.claimTask(t, "2026-01-01T00:02:00.000Z")).toBe(false);
    expect(repo.getTaskState(t)).toBe("running");
    expect(repo.getTask(t)?.leaseExpiresAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("extends a lease only while running, lists expired ones, and clears it when the task ends", () => {
    const t = repo.createTask(wf);
    expect(repo.extendLease(t, "2026-01-01T00:05:00.000Z")).toBe(false);
    repo.claimTask(t, "2026-01-01T00:01:00.000Z");
    expect(repo.listExpiredLeases("2026-01-01T00:00:59.000Z")).toEqual([]);
    expect(repo.listExpiredLeases("2026-01-01T00:01:01.000Z")).toEqual([t]);
    expect(repo.extendLease(t, "2026-01-01T00:05:00.000Z")).toBe(true);
    expect(repo.listExpiredLeases("2026-01-01T00:01:01.000Z")).toEqual([]);
    repo.setTaskState(t, "completed");
    expect(repo.getTask(t)?.leaseExpiresAt).toBeNull();
  });
});

describe("outbox", () => {
  const enqueue = (taskId: string, messageId: string, at = "2026-01-01T00:00:00.000Z") =>
    repo.enqueueOutbox({
      messageId,
      taskId,
      toAgent: "codex",
      payload: { x: 1 },
      nextAttemptAt: at,
    });

  it("dedupes by message id", () => {
    const t = repo.createTask(wf);
    expect(enqueue(t, "m1")).toBe(true);
    expect(enqueue(t, "m1")).toBe(false);
    expect(repo.listDueOutbox("2026-01-02T00:00:00.000Z", 10)).toHaveLength(1);
  });

  it("only returns pending rows that are due, oldest first", () => {
    const t = repo.createTask(wf);
    enqueue(t, "late", "2026-01-03T00:00:00.000Z");
    enqueue(t, "early", "2026-01-01T00:00:00.000Z");
    expect(repo.listDueOutbox("2026-01-02T00:00:00.000Z", 10).map((r) => r.messageId)).toEqual([
      "early",
    ]);
  });

  it("is written atomically with a state change and rolls back with it", () => {
    const t = repo.createTask(wf);
    expect(() =>
      repo.tx((r) => {
        r.setTaskState(t, "running");
        enqueue2(r, t, "m1");
        throw new Error("crash");
      }),
    ).toThrow("crash");
    expect(repo.getTaskState(t)).toBe("queued");
    expect(repo.listDueOutbox("9999-01-01T00:00:00.000Z", 10)).toHaveLength(0);
  });

  it("marks delivered, retries with a new time, then dead-letters after maxAttempts", () => {
    const t = repo.createTask(wf);
    enqueue(t, "m1");
    const [row] = repo.listDueOutbox("9999-01-01T00:00:00.000Z", 10);
    expect(row).toBeDefined();
    const id = row!.id;
    expect(repo.markOutboxFailed(id, "boom", "2026-02-01T00:00:00.000Z", 3)).toBe("pending");
    expect(repo.listDueOutbox("2026-01-15T00:00:00.000Z", 10)).toHaveLength(0);
    expect(repo.markOutboxFailed(id, "boom", "2026-02-02T00:00:00.000Z", 3)).toBe("pending");
    expect(repo.markOutboxFailed(id, "boom again", "2026-02-03T00:00:00.000Z", 3)).toBe(
      "dead_letter",
    );
    expect(repo.listDueOutbox("9999-01-01T00:00:00.000Z", 10)).toHaveLength(0);
    expect(repo.getOutbox("m1")).toMatchObject({
      status: "dead_letter",
      attempts: 3,
      lastError: "boom again",
    });
  });

  it("counts only pending rows per destination", () => {
    const t = repo.createTask(wf);
    enqueue(t, "m1");
    enqueue(t, "m2");
    expect(repo.countPendingOutbox("codex")).toBe(2);
    expect(repo.countPendingOutbox("claude")).toBe(0);
    repo.markOutboxDelivered(repo.getOutbox("m1")!.id);
    expect(repo.countPendingOutbox("codex")).toBe(1);
  });

  it("markOutboxDelivered removes the row from the due list", () => {
    const t = repo.createTask(wf);
    enqueue(t, "m1");
    const id = repo.listDueOutbox("9999-01-01T00:00:00.000Z", 10)[0]!.id;
    repo.markOutboxDelivered(id);
    expect(repo.listDueOutbox("9999-01-01T00:00:00.000Z", 10)).toHaveLength(0);
    expect(repo.getOutbox("m1")?.status).toBe("delivered");
  });
});

function enqueue2(r: Repo, taskId: string, messageId: string) {
  r.enqueueOutbox({
    messageId,
    taskId,
    toAgent: "codex",
    payload: {},
    nextAttemptAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("inbox (delivery ledger)", () => {
  it("accepts a (message, consumer) once and is idempotent afterwards", () => {
    expect(repo.receiveInbox("m1", "codex")).toBe(true);
    expect(repo.receiveInbox("m1", "codex")).toBe(false);
    expect(repo.receiveInbox("m1", "claude")).toBe(true);
  });

  it("ack records the time and reports whether it changed anything", () => {
    repo.receiveInbox("m1", "codex");
    expect(repo.ackInbox("m1", "codex")).toBe(true);
    expect(repo.ackInbox("m1", "codex")).toBe(false);
    expect(repo.ackInbox("nope", "codex")).toBe(false);
  });
});

describe("worktrees", () => {
  it("creates, transitions and lists; path and branch are unique", () => {
    const t1 = repo.createTask(wf);
    const t2 = repo.createTask(wf);
    const id = repo.createWorktree({
      workflowId: wf,
      taskId: t1,
      path: "C:/w/1",
      branch: "agent-studio/wf/t1",
      baseRef: "main",
    });
    expect(repo.getWorktreeForTask(t1)).toMatchObject({ id, state: "creating" });
    repo.setWorktreeState(id, "active");
    expect(repo.listWorktrees(wf)).toHaveLength(1);
    expect(repo.listWorktrees(wf)[0]?.state).toBe("active");
    expect(() =>
      repo.createWorktree({
        workflowId: wf,
        taskId: t2,
        path: "C:/w/1",
        branch: "b2",
        baseRef: "main",
      }),
    ).toThrow();
    expect(() => repo.setWorktreeState("missing", "active")).toThrow();
  });
});

describe("workflow roles", () => {
  it("upserts roles per workflow and assigns an agent only from the allowed list", () => {
    repo.upsertRole({
      workflowId: wf,
      name: "reviewer",
      instructions: "review only",
      permissions: "read-only",
      allowedAgents: ["codex", "claude"],
    });
    repo.assignRoleAgent(wf, "reviewer", "codex");
    expect(repo.listRoles(wf)).toEqual([
      expect.objectContaining({
        name: "reviewer",
        permissions: "read-only",
        allowedAgents: ["codex", "claude"],
        agentId: "codex",
      }),
    ]);
    expect(() => repo.assignRoleAgent(wf, "reviewer", "gemini")).toThrow(/not allowed/);
    expect(() => repo.assignRoleAgent(wf, "ghost", "codex")).toThrow(/Unknown role/);
  });

  it("upserting an existing role updates it and keeps the assignment", () => {
    const base = {
      workflowId: wf,
      name: "worker",
      permissions: "workspace-write" as const,
      allowedAgents: ["claude"],
    };
    repo.upsertRole({ ...base, instructions: "v1" });
    repo.assignRoleAgent(wf, "worker", "claude");
    repo.upsertRole({ ...base, instructions: "v2" });
    const roles = repo.listRoles(wf);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ instructions: "v2", agentId: "claude" });
  });
});

describe("context items", () => {
  it("stores provenance and filters by kind", () => {
    repo.addContextItem({
      workflowId: wf,
      kind: "goal",
      content: "ship it",
      source: "verified",
      createdBy: "user",
    });
    repo.addContextItem({
      workflowId: wf,
      kind: "artifact",
      content: "patch",
      path: "src/a.ts",
      sha256: sha,
      source: "agent_reported",
      createdBy: "claude",
    });
    expect(repo.listContextItems(wf)).toHaveLength(2);
    const arts = repo.listContextItems(wf, ["artifact"]);
    expect(arts).toEqual([
      expect.objectContaining({
        kind: "artifact",
        source: "agent_reported",
        path: "src/a.ts",
        sha256: sha,
      }),
    ]);
  });

  it("rejects a malformed hash and unknown kinds at the database", () => {
    expect(() =>
      repo.addContextItem({
        workflowId: wf,
        kind: "artifact",
        content: "x",
        sha256: "short",
        source: "verified",
        createdBy: "u",
      }),
    ).toThrow();
    expect(() =>
      repo.addContextItem({
        workflowId: wf,
        kind: "log" as never,
        content: "x",
        source: "verified",
        createdBy: "u",
      }),
    ).toThrow();
  });
});

describe("artifacts", () => {
  it("registers path + sha256 per task", () => {
    const t = repo.createTask(wf);
    repo.registerArtifact(t, "src/a.ts", sha);
    expect(repo.listArtifacts(t)).toEqual([
      expect.objectContaining({ path: "src/a.ts", sha256: sha }),
    ]);
    expect(() => repo.registerArtifact(t, "src/b.ts", "bad")).toThrow();
  });
});

describe("approvals", () => {
  it("creates pending, resolves once, and refuses a second resolution", () => {
    const t = repo.createTask(wf);
    const id = repo.createApproval(t, { tool: "Write" });
    expect(repo.listApprovals("pending")).toHaveLength(1);
    repo.resolveApproval(id, "approved");
    expect(repo.listApprovals("approved")).toHaveLength(1);
    expect(() => repo.resolveApproval(id, "denied")).toThrow(/not pending/);
  });

  it("expires only pending approvals whose time has passed", () => {
    const t = repo.createTask(wf);
    const old = repo.createApproval(t, {}, "2026-01-01T00:00:00.000Z");
    const fresh = repo.createApproval(t, {}, "2099-01-01T00:00:00.000Z");
    const noExpiry = repo.createApproval(t, {});
    expect(repo.expireApprovals("2026-06-01T00:00:00.000Z")).toEqual([old]);
    expect(
      repo
        .listApprovals("pending")
        .map((a) => a.id)
        .sort(),
    ).toEqual([fresh, noExpiry].sort());
    expect(() => repo.resolveApproval(old, "approved")).toThrow(/not pending/);
  });
});
