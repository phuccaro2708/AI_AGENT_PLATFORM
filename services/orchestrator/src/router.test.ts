import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@agent-studio/contracts";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { BackpressureError, MessageRouter, type RouterOptions } from "./router.js";

let dir: string;
let db: StudioDb;
let repo: Repo;
let wf: string;
let task: string;
let nowMs: number;
const clock = () => new Date(nowMs);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-router-"));
  db = openDatabase(join(dir, "test.db"));
  runMigrations(db);
  repo = new Repo(db);
  wf = repo.createWorkflow(repo.createProject("demo", "/p"));
  task = repo.createTask(wf);
  nowMs = Date.parse("2026-01-01T00:00:00.000Z");
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const router = (over: Partial<RouterOptions> = {}) =>
  new MessageRouter({ repo, clock, random: () => 1, baseDelayMs: 1000, maxAttempts: 3, ...over });

let n = 0;
const msg = (
  over: Partial<Omit<AgentMessage, "sequence">> = {},
): Omit<AgentMessage, "sequence"> => ({
  id: `m${++n}`,
  schemaVersion: 1,
  workflowId: wf,
  taskId: task,
  correlationId: "c1",
  fromAgent: "orchestrator",
  toAgent: "codex",
  type: "agent.message",
  payload: { text: "hi" },
  createdAt: new Date(nowMs).toISOString(),
  ...over,
});

describe("send", () => {
  it("stores the message and its outbox row together, with DB-derived sequence", () => {
    const r = router();
    const a = r.send(msg());
    const b = r.send(msg());
    expect(a.duplicate).toBe(false);
    expect([a.message.sequence, b.message.sequence]).toEqual([0, 1]);
    expect(repo.getOutbox(a.message.id)?.status).toBe("pending");
  });

  it("a duplicate id is a no-op that reports the original", () => {
    const r = router();
    const first = r.send(msg({ id: "dup" }));
    const again = r.send(msg({ id: "dup" }));
    expect(again.duplicate).toBe(true);
    expect(again.message.sequence).toBe(first.message.sequence);
    expect(repo.listMessages(task)).toHaveLength(1);
  });

  it("rolls back message and outbox together if it dies before commit", () => {
    const r = router({
      failpoint: (p) => {
        if (p === "send:before-commit") throw new Error("crash");
      },
    });
    expect(() => r.send(msg({ id: "x" }))).toThrow("crash");
    expect(repo.listMessages(task)).toHaveLength(0);
    expect(repo.getOutbox("x")).toBeUndefined();
  });

  it("applies backpressure per destination", () => {
    const r = router({ maxPendingPerConsumer: 2 });
    r.send(msg());
    r.send(msg());
    expect(() => r.send(msg())).toThrow(BackpressureError);
    expect(() => r.send(msg({ toAgent: "claude" }))).not.toThrow();
  });
});

describe("tick", () => {
  it("delivers to the registered consumer, acks, and marks delivered", async () => {
    const seen: string[] = [];
    const r = router();
    r.register("codex", (m) => void seen.push(m.id));
    const { message } = r.send(msg());
    expect(await r.tick()).toMatchObject({ delivered: 1, retried: 0, deadLettered: 0 });
    expect(seen).toEqual([message.id]);
    expect(repo.getOutbox(message.id)?.status).toBe("delivered");
    expect(await r.tick()).toMatchObject({ delivered: 0 });
  });

  it("retries a failing handler with growing backoff, then dead-letters", async () => {
    let calls = 0;
    const r = router();
    r.register("codex", () => {
      calls++;
      throw new Error("down");
    });
    const { message } = r.send(msg());
    expect(await r.tick()).toMatchObject({ retried: 1 });
    expect(await r.tick()).toMatchObject({ delivered: 0, retried: 0 }); // not due yet
    nowMs += 1000; // base * 2^0 with jitter fixed at 1
    expect(await r.tick()).toMatchObject({ retried: 1 });
    nowMs += 1999; // second delay is 2000
    expect(await r.tick()).toMatchObject({ retried: 0, deadLettered: 0 });
    nowMs += 1;
    expect(await r.tick()).toMatchObject({ deadLettered: 1 });
    expect(calls).toBe(3);
    expect(repo.getOutbox(message.id)).toMatchObject({ status: "dead_letter", lastError: "down" });
  });

  it("jitter scales the delay between half and full", async () => {
    const r = router({ random: () => 0 });
    r.register("codex", () => {
      throw new Error("down");
    });
    const { message } = r.send(msg());
    await r.tick();
    expect(repo.getOutbox(message.id)?.nextAttemptAt).toBe(new Date(nowMs + 500).toISOString());
  });

  it("a missing consumer counts as a failed attempt, not a crash", async () => {
    const r = router();
    const { message } = r.send(msg({ toAgent: "ghost" }));
    expect(await r.tick()).toMatchObject({ retried: 1 });
    expect(repo.getOutbox(message.id)?.lastError).toMatch(/no consumer/i);
  });

  it("never runs two ticks at once", async () => {
    const r = router();
    let release!: () => void;
    r.register(
      "codex",
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    r.send(msg());
    const first = r.tick();
    expect(await r.tick()).toEqual({ delivered: 0, retried: 0, deadLettered: 0, skipped: true });
    release();
    expect(await first).toMatchObject({ delivered: 1 });
  });
});

describe("crash and restart (same DB file, new router)", () => {
  for (const point of ["deliver:after-receive", "deliver:after-handler"] as const) {
    it(`a crash at ${point} loses nothing and delivers after restart`, async () => {
      const handled: string[] = [];
      const crashing = router({
        failpoint: (p) => {
          if (p === point) throw new Error("crash");
        },
      });
      crashing.register("codex", (m) => void handled.push(m.id));
      const { message } = crashing.send(msg());
      await expect(crashing.tick()).rejects.toThrow("crash");
      expect(repo.getOutbox(message.id)?.status).toBe("pending"); // still owed

      const restarted = router();
      restarted.register("codex", (m) => void handled.push(m.id));
      expect(await restarted.tick()).toMatchObject({ delivered: 1 });
      expect(repo.getOutbox(message.id)?.status).toBe("delivered");
      // at-least-once: only a crash after the handler may repeat it.
      expect(handled.length).toBe(point === "deliver:after-handler" ? 2 : 1);
    });
  }

  it("an already-acked message is not handled again", async () => {
    const handled: string[] = [];
    const r = router();
    r.register("codex", (m) => void handled.push(m.id));
    const { message } = r.send(msg());
    // Simulate: handler ran and acked, but the process died before the outbox row was marked.
    repo.receiveInbox(message.id, "codex");
    repo.ackInbox(message.id, "codex");
    expect(await r.tick()).toMatchObject({ delivered: 1 });
    expect(handled).toEqual([]);
    expect(repo.getOutbox(message.id)?.status).toBe("delivered");
  });
});
