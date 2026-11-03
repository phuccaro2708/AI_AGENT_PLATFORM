import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, Repo, type StudioDb } from "./index.js";

let dir: string;
let db: StudioDb;
let repo: Repo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-tx-"));
  db = openDatabase(join(dir, "test.db"));
  runMigrations(db);
  repo = new Repo(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const seed = () => {
  const p = repo.createProject("demo", "/p");
  const w = repo.createWorkflow(p);
  return { w, t: repo.createTask(w, "stub") };
};
const draft = (taskId: string, id: string) => ({
  id,
  schemaVersion: 1 as const,
  workflowId: "wf",
  taskId,
  correlationId: "c",
  fromAgent: "stub",
  toAgent: "orchestrator",
  type: "task.progress" as const,
  payload: { n: 1 },
  createdAt: new Date().toISOString(),
});

describe("Repo.tx", () => {
  it("commits every write made through the transactional repo", () => {
    const { t } = seed();
    repo.tx((r) => {
      r.setTaskState(t, "running");
      r.appendMessageAuto(draft(t, "m1"));
    });
    expect(repo.getTaskState(t)).toBe("running");
    expect(repo.listMessages(t)).toHaveLength(1);
  });

  it("rolls back state, event and message together when the callback throws", () => {
    const { t } = seed();
    expect(() =>
      repo.tx((r) => {
        r.setTaskState(t, "running");
        r.appendMessageAuto(draft(t, "m1"));
        throw new Error("crash before commit");
      }),
    ).toThrow("crash before commit");
    expect(repo.getTaskState(t)).toBe("queued");
    expect(repo.listMessages(t)).toHaveLength(0);
    expect(repo.listEvents(t)).toHaveLength(0);
  });

  it("returns the callback result", () => {
    const { t } = seed();
    expect(repo.tx((r) => r.appendMessageAuto(draft(t, "m1")).sequence)).toBe(0);
  });
});

describe("appendMessageAuto", () => {
  it("assigns consecutive sequences per task, independent across tasks", () => {
    const { w, t } = seed();
    const t2 = repo.createTask(w, "stub");
    expect(repo.appendMessageAuto(draft(t, "a")).sequence).toBe(0);
    expect(repo.appendMessageAuto(draft(t, "b")).sequence).toBe(1);
    expect(repo.appendMessageAuto(draft(t2, "c")).sequence).toBe(0);
  });

  it("continues after existing messages so a requeued task cannot collide", () => {
    const { t } = seed();
    repo.appendMessage(draft(t, "old0"), 0);
    repo.appendMessage(draft(t, "old1"), 1);
    expect(repo.appendMessageAuto(draft(t, "new")).sequence).toBe(2);
  });
});
