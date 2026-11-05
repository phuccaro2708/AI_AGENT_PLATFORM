import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "@agent-studio/orchestrator";

/**
 * P4-10 soak skeleton. Runs SOAK_ROUNDS (default 100) workflows one after another through the real SidecarService
 * (real SQLite, real git worktrees for the peer-review rounds) with fake adapters, and after EVERY round checks:
 *   - the workflow reached the state this round was designed to reach, with the expected task states;
 *   - nothing is left queued / running / waiting_approval anywhere in the database;
 *   - message sequences are contiguous per task and every task has a terminal state;
 *   - the number of tasks / completed tasks matches what has been started so far (no lost or duplicated state).
 * At the end it compares the process' active handles / timers with a baseline taken after warm-up, and after
 * `svc.close()` with the state before the sidecar was opened.
 *
 * Kept apart from the fast suite by location (tests/soak/). Split it with:
 *   pnpm exec vitest run --exclude "tests/soak/**"     (fast suite only)
 *   pnpm exec vitest run tests/soak                    (soak only)
 * No real CLI is involved; the "manual real-CLI soak" is a separate, human task.
 */
const ROUNDS = Math.max(1, Number(process.env["SOAK_ROUNDS"] ?? 100));

type Kind = "plain" | "unfinished_tool" | "review_approve" | "review_changes";
const kindOf = (i: number): Kind =>
  i % 10 === 9
    ? "review_changes"
    : i % 5 === 4
      ? "review_approve"
      : i % 7 === 3
        ? "unfinished_tool"
        : "plain";

/** Tasks and their final states each kind must produce (in creation order). */
const EXPECTED: Record<Kind, { workflow: "completed" | "failed" | "any"; tasks: string[] }> = {
  plain: { workflow: "any", tasks: ["completed"] },
  unfinished_tool: { workflow: "any", tasks: ["needs_reconciliation"] },
  review_approve: { workflow: "completed", tasks: ["completed", "completed"] },
  review_changes: {
    workflow: "completed",
    tasks: ["completed", "completed", "completed", "completed"],
  },
};

class Fake implements AgentAdapter {
  calls = 0;
  constructor(
    readonly id: string,
    private readonly play: (task: AgentTask, n: number) => AgentEvent[],
  ) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    const n = this.calls++;
    for (const e of this.play(task, n)) yield e;
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const handles = () => {
  const out: Record<string, number> = {};
  for (const h of process.getActiveResourcesInfo()) out[h] = (out[h] ?? 0) + 1;
  return out;
};
/** Timeouts + sockets + child processes + FS watchers: what a leak would grow. */
const leakSensitive = (h: Record<string, number>) =>
  ["Timeout", "TCPSocketWrap", "ChildProcess", "FSWatcher", "PipeWrap", "Immediate"].reduce(
    (sum, k) => sum + (h[k] ?? 0),
    0,
  );

/**
 * `process.getActiveResourcesInfo()` skips unref'd timers, and the scheduler's timers are unref'd, so it cannot see
 * them. This counts live intervals/timeouts created through the global functions (what the product code uses).
 */
const NL = String.fromCharCode(10);
function spyOnTimers() {
  const live = new Map<unknown, { interval: boolean; at: string }>();
  const real = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const wrapSet =
    (set: (...a: never[]) => unknown, repeats: boolean) =>
    (cb: () => void, ...rest: unknown[]) => {
      const ref: { h?: unknown } = {};
      const fn = repeats
        ? cb
        : () => {
            live.delete(ref.h); // a one-shot timeout is no longer pending once it fires
            cb();
          };
      const h = (set as (...a: unknown[]) => unknown)(fn, ...rest);
      ref.h = h;
      live.set(h, {
        interval: repeats,
        at: new Error().stack?.split(NL).slice(2, 4).join(" | ") ?? "",
      });
      return h;
    };
  const wrapClear = (clear: (h: never) => void) => (h: never) => {
    live.delete(h);
    clear(h);
  };
  globalThis.setInterval = wrapSet(real.setInterval as never, true) as never;
  globalThis.clearInterval = wrapClear(real.clearInterval as never) as never;
  globalThis.setTimeout = wrapSet(real.setTimeout as never, false) as never;
  globalThis.clearTimeout = wrapClear(real.clearTimeout as never) as never;
  return {
    /** Pending intervals (never end by themselves: a leak if they outlive close()). */
    intervals: () => [...live.values()].filter((v) => v.interval).length,
    /** Pending one-shot timeouts (end by themselves; e.g. process-manager's 1 s stdio grace timer). */
    timeouts: () => [...live.values()].filter((v) => !v.interval).length,
    where: () => [...live.values()].map((v) => v.at).join(NL),
    restore: () => Object.assign(globalThis, real),
  };
}

let dir: string;
let svc: SidecarService | undefined;
let rpcId = 0;
type Rpc = { result?: Record<string, unknown>; error?: { message: string } };
const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc!.handle({ id: ++rpcId, method, ...(params ? { params } : {}) });
  const r = response as Rpc;
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result as T;
};

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "as-soak-")));
  mkdirSync(join(dir, "data"));
});
afterAll(() => {
  svc?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("soak: many workflows through SidecarService with fake adapters", () => {
  it(
    `runs ${ROUNDS} workflows back to back; DB stays consistent and nothing leaks`,
    async () => {
      const before = handles();
      const timers = spyOnTimers();
      const liveBefore = timers.intervals();
      const timeoutsBefore = timers.timeouts();

      const plain = new Fake("plain", () => [
        { type: "text", content: "ok" },
        { type: "completed" },
      ]);
      const tool = new Fake("tool", () => [
        { type: "tool_call", name: "bash", args: { command: "x" }, callId: "c" },
        { type: "error", message: "crashed" },
      ]);
      const impl = new Fake("impl", (task, n) => {
        writeFileSync(join(task.cwd, `f${n}.txt`), `round ${n}\n`);
        return [{ type: "text", content: `wrote f${n}` }, { type: "completed" }];
      });
      // review_changes asks for changes on its first review; review_approve approves at once.
      let reviewMode: "approve" | "changes" = "approve";
      let reviewsInRound = 0;
      const rev = new Fake("rev", () => {
        reviewsInRound++;
        const changes = reviewMode === "changes" && reviewsInRound === 1;
        const verdict = changes
          ? { verdict: "request_changes", comments: ["please tidy"] }
          : { verdict: "approve", comments: [] };
        return [{ type: "text", content: JSON.stringify(verdict) }, { type: "completed" }];
      });

      const plainRoot = join(dir, "plain-project");
      mkdirSync(plainRoot);
      const repoRoot = join(dir, "repo");
      mkdirSync(repoRoot);
      git(repoRoot, "init", "-q", "-b", "main");
      git(repoRoot, "config", "user.email", "t@example.com");
      git(repoRoot, "config", "user.name", "t");
      git(repoRoot, "config", "core.autocrlf", "false");
      writeFileSync(join(repoRoot, "README.md"), "soak\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-q", "-m", "init");

      svc = new SidecarService(
        {
          dbPath: join(dir, "data", "soak.db"),
          extraAdapters: [plain, tool, impl, rev],
          worktreesDir: join(dir, "wt"),
          schedulerIntervalMs: 10,
          probes: {},
        },
        createLogger({ name: "soak", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
      );
      const sql = svc.db.$client;
      const count = (q: string, ...p: unknown[]): number =>
        (sql.prepare(q).get(...p) as { c: number }).c;

      const { projectId: plainProject } = await call<{ projectId: string }>("projects.create", {
        name: "plain",
        rootPath: plainRoot,
      });
      const { projectId: repoProject } = await call<{ projectId: string }>("projects.create", {
        name: "repo",
        rootPath: repoRoot,
      });

      let expectedTasks = 0;
      let expectedCompleted = 0;
      let expectedReconcile = 0;
      let warm: number | undefined;
      let warmTimers: number | undefined;
      // The spy must actually see the sidecar's intervals, otherwise the leak check below proves nothing.
      const liveOpen = timers.intervals();
      expect(liveOpen, "spy sees the sidecar's intervals").toBeGreaterThan(liveBefore);
      const t0 = Date.now();
      const slowest = { ms: 0, round: -1 };

      for (let i = 0; i < ROUNDS; i++) {
        const kind = kindOf(i);
        const exp = EXPECTED[kind];
        const started = Date.now();
        let workflowId: string;
        if (kind === "plain" || kind === "unfinished_tool") {
          ({ workflowId } = await call<{ workflowId: string }>("workflows.create", {
            projectId: plainProject,
          }));
          await call("workflows.start", {
            workflowId,
            agentId: kind === "plain" ? "plain" : "tool",
            prompt: `round ${i}`,
          });
        } else {
          reviewMode = kind === "review_changes" ? "changes" : "approve";
          reviewsInRound = 0;
          ({ workflowId } = await call<{ workflowId: string }>("workflows.create", {
            projectId: repoProject,
          }));
          await call("workflows.startPeerReview", {
            workflowId,
            implementerAgent: "impl",
            reviewerAgent: "rev",
            goal: `round ${i}`,
          });
        }

        // wait for the workflow to settle (a bounded wait: a hang is a failure, not a timeout of the whole test)
        const deadline = Date.now() + 30_000;
        let state: string;
        for (;;) {
          const r = await call<{ workflowState: string; tasks: { state: string }[] }>(
            "tasks.list",
            {
              workflowId,
            },
          );
          state = r.workflowState;
          // A single-task workflow (workflows.start) has no terminal workflow state of its own: its tasks settle.
          const terminal = (st: string) =>
            ["completed", "failed", "cancelled", "needs_reconciliation"].includes(st);
          const settled =
            exp.workflow === "any"
              ? r.tasks.length > 0 && r.tasks.every((t) => terminal(t.state))
              : state === "completed" || state === "failed";
          if (settled) break;
          if (Date.now() > deadline) throw new Error(`round ${i} (${kind}) did not settle`);
          await new Promise((res) => setTimeout(res, 5));
        }
        await svc.idle();

        const { tasks } = await call<{ tasks: { id: string; state: string }[] }>("tasks.list", {
          workflowId,
        });
        if (exp.workflow !== "any") expect(state, `round ${i} ${kind} workflow`).toBe(exp.workflow);
        expect(
          tasks.map((t) => t.state),
          `round ${i} ${kind} tasks`,
        ).toEqual(exp.tasks);

        expectedTasks += exp.tasks.length;
        expectedCompleted += exp.tasks.filter((s) => s === "completed").length;
        expectedReconcile += exp.tasks.filter((s) => s === "needs_reconciliation").length;

        // ---- database consistency after EVERY round ----
        expect(
          count(
            "SELECT COUNT(*) c FROM tasks WHERE state IN ('queued','running','waiting_approval')",
          ),
          `round ${i}: tasks stuck in a non-terminal state`,
        ).toBe(0);
        expect(count("SELECT COUNT(*) c FROM tasks"), `round ${i}: task count`).toBe(expectedTasks);
        expect(count("SELECT COUNT(*) c FROM tasks WHERE state='completed'")).toBe(
          expectedCompleted,
        );
        expect(count("SELECT COUNT(*) c FROM tasks WHERE state='needs_reconciliation'")).toBe(
          expectedReconcile,
        );
        // messages: sequences of every task of this workflow are 0..n-1 with no gap or duplicate
        for (const t of tasks) {
          const row = sql
            .prepare(
              "SELECT COUNT(*) n, MIN(sequence) lo, MAX(sequence) hi FROM messages WHERE task_id = ?",
            )
            .get(t.id) as { n: number; lo: number | null; hi: number | null };
          expect(row.n, `round ${i} task ${t.id} has messages`).toBeGreaterThan(0);
          expect([row.lo, row.hi], `round ${i} task ${t.id} sequence range`).toEqual([
            0,
            row.n - 1,
          ]);
        }
        // no worktree row left half-created or removing
        expect(
          count("SELECT COUNT(*) c FROM worktrees WHERE state IN ('creating','removing')"),
          `round ${i}: worktree rows`,
        ).toBe(0);

        const ms = Date.now() - started;
        if (ms > slowest.ms) {
          slowest.ms = ms;
          slowest.round = i;
        }
        if (i === Math.min(19, ROUNDS - 1)) {
          warm = leakSensitive(handles());
          warmTimers = timers.intervals();
        }
      }
      const elapsed = Date.now() - t0;

      // ---- totals ----
      expect(count("SELECT COUNT(*) c FROM tasks WHERE state='completed'")).toBe(expectedCompleted);
      expect(plain.calls + tool.calls + impl.calls + rev.calls).toBe(expectedTasks);

      // ---- leaks: handles/timers must not grow with the number of rounds ----
      await svc.idle();
      const after = leakSensitive(handles());
      expect(after, `handles after ${ROUNDS} rounds vs after 20 (warm)`).toBeLessThanOrEqual(
        (warm ?? after) + 3,
      );
      const endTimers = timers.intervals();
      expect(
        endTimers,
        `live intervals after ${ROUNDS} rounds vs after warm-up:
${timers.where()}`,
      ).toBeLessThanOrEqual(warmTimers ?? endTimers);
      const client = svc.db.$client;
      svc.close();
      svc = undefined;
      // the longest self-ending timer in the product is process-manager's 1 s stdio grace timer
      await new Promise((res) => setTimeout(res, 1300));
      const closed = leakSensitive(handles());
      expect(closed, "handles after close() vs before the sidecar was opened").toBeLessThanOrEqual(
        leakSensitive(before) + 2,
      );
      const closedTimers = timers.intervals();
      const closedTimeouts = timers.timeouts();
      const whereClosed = timers.where();
      timers.restore();
      expect(
        closedTimers,
        `live intervals after close() vs before the sidecar was opened:${NL}${whereClosed}`,
      ).toBe(liveBefore);
      expect(closedTimeouts, "pending timeouts 1.3 s after close()").toBe(timeoutsBefore);
      expect(client.open, "database connection closed").toBe(false);

      console.info(
        `[soak] rounds=${ROUNDS} tasks=${expectedTasks} completed=${expectedCompleted} ` +
          `needs_reconciliation=${expectedReconcile} elapsed=${elapsed}ms ` +
          `(${(elapsed / ROUNDS).toFixed(0)} ms/round, slowest round #${slowest.round}: ${slowest.ms}ms) ` +
          `handles before=${leakSensitive(before)} warm=${warm} end=${after} closed=${closed} ` +
          `intervals(spy) open=${liveOpen - liveBefore} warm=${warmTimers} end=${endTimers} closed=${closedTimers} timeouts-after-close=${closedTimeouts}`,
      );
    },
    Math.max(120_000, ROUNDS * 3_000),
  );
});
