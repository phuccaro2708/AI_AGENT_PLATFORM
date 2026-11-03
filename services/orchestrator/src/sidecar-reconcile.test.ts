import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { SidecarEvent } from "@agent-studio/contracts";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

let dir: string;
let svc: SidecarService;
let events: SidecarEvent[];
let n = 0;

const open = () =>
  new SidecarService(
    { dbPath: join(dir, "s.db"), onEvent: (e) => events.push(e) },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );

const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
};

/** A task that was `running` when the process died; restarting turns it into needs_reconciliation. */
function seedCrashedTask(id: string) {
  const ts = new Date().toISOString();
  const run = (q: string, ...a: unknown[]) => svc.db.$client.prepare(q).run(...a);
  run("insert or ignore into projects (id,name,root_path,created_at) values ('p','n','r',?)", ts);
  run("insert or ignore into workflows (id,project_id,state,created_at) values ('w','p','running',?)", ts);
  run(
    "insert into tasks (id,workflow_id,state,created_at,updated_at) values (?,'w','running',?,?)",
    id,
    ts,
    ts,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-reconcile-"));
  events = [];
  svc = open();
  for (const id of ["t1", "t2", "t3"]) seedCrashedTask(id);
  svc.close();
  svc = open(); // restart: the three tasks are now needs_reconciliation
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("tasks.resolveReconciliation", () => {
  it("settles a task on the user's decision, records the note and announces the new state", async () => {
    expect((await call<{ state: string }>("queryTask", { taskId: "t1" })).state).toBe(
      "needs_reconciliation",
    );
    const r = await call<{ state: string }>("tasks.resolveReconciliation", {
      taskId: "t1",
      decision: "completed",
      note: "checked the worktree, the file is there",
    });
    expect(r.state).toBe("completed");
    expect(events).toContainEqual({
      event: "task.state",
      taskId: "t1",
      state: "completed",
      reason: "reconciled by user: checked the worktree, the file is there",
    });
    const failed = await call<{ state: string }>("tasks.resolveReconciliation", {
      taskId: "t2",
      decision: "failed",
      note: "nothing was written",
    });
    expect(failed.state).toBe("failed");
  });

  it("requeue puts the task back in the queue and raises its attempt; nothing else re-runs it", async () => {
    const before = svc.db.$client.prepare("select attempt from tasks where id='t3'").get() as {
      attempt: number;
    };
    const r = await call<{ state: string }>("tasks.resolveReconciliation", {
      taskId: "t3",
      decision: "requeue",
      note: "verified nothing was changed",
    });
    expect(r.state).toBe("queued");
    const after = svc.db.$client.prepare("select attempt from tasks where id='t3'").get() as {
      attempt: number;
    };
    expect(after.attempt).toBe(before.attempt + 1);
  });

  it("refuses a task that is not waiting for reconciliation, an unknown task and a missing note", async () => {
    await call("tasks.resolveReconciliation", { taskId: "t1", decision: "failed", note: "done" });
    await expect(
      call("tasks.resolveReconciliation", { taskId: "t1", decision: "completed", note: "again" }),
    ).rejects.toThrow(/not needs_reconciliation/);
    await expect(
      call("tasks.resolveReconciliation", { taskId: "nope", decision: "failed", note: "abc" }),
    ).rejects.toThrow(/Unknown task/);
    for (const note of ["", "  ", "x"]) {
      await expect(
        call("tasks.resolveReconciliation", { taskId: "t2", decision: "failed", note }),
      ).rejects.toThrow();
    }
    expect((await call<{ state: string }>("queryTask", { taskId: "t2" })).state).toBe(
      "needs_reconciliation",
    );
  });
});
