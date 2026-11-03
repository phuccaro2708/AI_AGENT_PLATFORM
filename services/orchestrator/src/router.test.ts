import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { Router, backoffMs } from "./router.js";

let dir: string;
let db: StudioDb;
let repo: Repo;
let taskId: string;
let clock: number;

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const msg = (id: string, to = "codex") => ({
  id,
  schemaVersion: 1 as const,
  workflowId: "wf",
  taskId,
  correlationId: "c",
  fromAgent: "claude",
  toAgent: to,
  type: "review.request" as const,
  payload: {},
  createdAt: new Date(T0).toISOString(),
});
const mkRouter = (handler: (m: { id: string }) => Promise<void>, maxAttempts = 3) =>
  new Router(repo, () => handler, {
    maxAttempts,
    now: () => new Date(clock),
    rand: () => 1, // deterministic: full delay
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-router-"));
  db = openDatabase(join(dir, "t.db"));
  runMigrations(db);
  repo = new Repo(db);
  const w = repo.createWorkflow(repo.createProject("p", "/p"));
  taskId = repo.createTask(w, "claude");
  clock = T0;
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("backoffMs", () => {
  it("grows exponentially, is capped, and jitter scales within [0, delay]", () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(20, () => 1)).toBe(60_000);
    expect(backoffMs(3, () => 0)).toBe(0);
    expect(backoffMs(3, () => 0.5)).toBe(4000);
  });
});

describe("Router.deliverDue", () => {
  it("delivers once and marks delivered", async () => {
    repo.appendMessageWithOutbox(msg("m1"), 0);
    const seen: string[] = [];
    const r = mkRouter(async (m) => void seen.push(m.id));
    expect(await r.deliverDue()).toMatchObject({ delivered: 1, retried: 0, dead: 0 });
    expect(await r.deliverDue()).toMatchObject({ delivered: 0 });
    expect(seen).toEqual(["m1"]);
  });

  it("retries after a failure only once the backoff has elapsed, then dead-letters", async () => {
    repo.appendMessageWithOutbox(msg("m1"), 0);
    const r = mkRouter(async () => {
      throw new Error("down");
    }, 2);
    expect(await r.deliverDue()).toMatchObject({ retried: 1 });
    expect(await r.deliverDue()).toMatchObject({ retried: 0, delivered: 0 }); // not due yet
    clock += 1000;
    expect(await r.deliverDue()).toMatchObject({ dead: 1 });
    expect(repo.listDeadLetters()).toMatchObject([{ messageId: "m1", lastError: "down" }]);
  });

  it("does not run the handler again for a message already accepted (duplicate delivery)", async () => {
    repo.appendMessageWithOutbox(msg("m1"), 0);
    // simulate crash after handling+inbox write but before markDelivered
    repo.acceptInbound("codex", "m1", new Date(T0).toISOString());
    let calls = 0;
    const r = mkRouter(async () => void calls++);
    expect(await r.deliverDue()).toMatchObject({ delivered: 0, duplicates: 1 });
    expect(calls).toBe(0);
    expect(repo.claimDueDeliveries(new Date(clock).toISOString(), 10)).toHaveLength(0);
  });

  it("backpressure: handles at most batchSize per tick", async () => {
    for (let i = 0; i < 5; i++) repo.appendMessageWithOutbox(msg(`m${i}`), i);
    const r = new Router(repo, () => async () => {}, {
      batchSize: 2,
      now: () => new Date(clock),
      rand: () => 1,
    });
    expect(await r.deliverDue()).toMatchObject({ delivered: 2 });
  });
});
