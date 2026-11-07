import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { Writable } from "node:stream";
import { ClaudeAdapter } from "@agent-studio/adapter-claude";
import { CodexAdapter } from "@agent-studio/adapter-codex";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "@agent-studio/orchestrator";
import {
  CLI_NAME,
  ProcessTracker,
  listProcesses,
  renderTable,
  type WorkflowRow,
} from "./real-cli-metrics";

/**
 * MANUAL, OPT-IN small soak with the REAL `claude` and `codex` through the real SidecarService (P4-10, item 7b).
 * Skipped unless `AGENT_STUDIO_REAL_CLI_SOAK` is set (a number 1..5 = how many workflows, `1` is just one). It spends
 * model usage, so it is HARD-CAPPED at 5 workflows: a larger value is clamped, never expanded. Run:
 *
 *   AGENT_STUDIO_REAL_CLI_SOAK=5 pnpm exec vitest run tests/soak/sidecar-soak-real-cli.test.ts
 *   (PowerShell: $env:AGENT_STUDIO_REAL_CLI_SOAK = "5"; …)
 *
 * Scope (agreed with the user): tiny prompts that carry no project code, secrets or paths; every project directory is
 * a fresh empty git repo under the OS temp dir; no CLI configuration is changed. Workflows, in order:
 *   1 claude plain, 2 codex plain, 3 claude plain, 4 codex plain, 5 peer review (claude implements, codex reviews).
 * What the model answers varies, so assertions are SAFETY/consistency invariants only (every task terminal, DB
 * consistent, no leaked handles/intervals, no secret in the log or the stored messages). The observed facts
 * (per workflow: id, final state, ms, task count and states, CLI processes left alive) go to the JSON file named by
 * AGENT_STUDIO_REAL_CLI_SOAK_OUT plus a Markdown table next to it (same name, `.md`); keep both OUTSIDE the repo and
 * summarise the table by hand in docs/ASSUMPTIONS.md (d8). Orphans are measured by sampling this process' descendants
 * (OS process list) every ~0.7 s and checking, after each workflow and after close, which of them are still alive
 * (same pid AND creation time). A process that starts and dies between two samples is not seen.
 */
const RAW = Number(process.env["AGENT_STUDIO_REAL_CLI_SOAK"] ?? 0);
const N = Math.min(5, Math.max(0, Number.isFinite(RAW) ? Math.floor(RAW) : 0));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const handles = () => {
  const out: Record<string, number> = {};
  for (const h of process.getActiveResourcesInfo()) out[h] = (out[h] ?? 0) + 1;
  return out;
};
const leakSensitive = (h: Record<string, number>) =>
  ["Timeout", "TCPSocketWrap", "ChildProcess", "FSWatcher", "PipeWrap", "Immediate"].reduce(
    (sum, k) => sum + (h[k] ?? 0),
    0,
  );

/** Secret-looking values in this process' environment (never printed, only searched for). */
function secretNeedles(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) out.push(v);
  }
  return out;
}
const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
];

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
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "as-real-soak-")));
  mkdirSync(join(dir, "data"));
});
afterAll(() => {
  svc?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe.skipIf(N === 0)("real-CLI soak (opt-in, at most 5 workflows)", () => {
  it(
    `runs ${N} real workflow(s); tasks terminal, DB consistent, no leaks, no secret in logs`,
    async () => {
      const before = leakSensitive(handles());
      let logText = "";
      const log = createLogger({
        name: "real-soak",
        destination: new Writable({
          write(c, _e, cb) {
            logText += String(c);
            cb();
          },
        }),
      });

      const claude = new ClaudeAdapter({
        id: "rclaude",
        // same isolation/cost limits as the earlier real runs (docs/ASSUMPTIONS.md): small model, no tools, capped
        extraArgs: ["--model", "haiku", "--no-session-persistence", "--max-budget-usd", "0.3"],
      });
      const claudeImpl = new ClaudeAdapter({
        id: "rclaude-impl",
        safeMode: false,
        extraArgs: [
          "--model",
          "haiku",
          "--no-session-persistence",
          "--max-budget-usd",
          "0.3",
          "--setting-sources",
          "local",
          "--disable-slash-commands",
          "--tools",
          "Write",
        ],
      });
      const codex = new CodexAdapter({
        id: "rcodex",
        extraArgs: ["--skip-git-repo-check", "--ephemeral", "-c", "model_reasoning_effort=low"],
      });

      const dbPath = join(dir, "data", "real.db");
      svc = new SidecarService(
        {
          dbPath,
          extraAdapters: [claude, claudeImpl, codex],
          worktreesDir: join(dir, "wt"),
          schedulerIntervalMs: 50,
          probes: {},
        },
        log,
      );
      const sql = svc.db.$client;
      const count = (q: string): number => (sql.prepare(q).get() as { c: number }).c;

      const freshRepo = (name: string): string => {
        const root = join(dir, name);
        mkdirSync(root);
        git(root, "init", "-q", "-b", "main");
        git(root, "config", "user.email", "t@example.com");
        git(root, "config", "user.name", "t");
        git(root, "config", "core.autocrlf", "false");
        writeFileSync(join(root, "README.md"), "soak\n");
        git(root, "add", ".");
        git(root, "commit", "-q", "-m", "init");
        return root;
      };

      const PROMPT = "Reply with exactly the word: ok. Do not use any tools.";
      const plan: { kind: "plain" | "review"; agent?: string }[] = [
        { kind: "plain", agent: "rclaude" },
        { kind: "plain", agent: "rcodex" },
        { kind: "plain", agent: "rclaude" },
        { kind: "plain", agent: "rcodex" },
        { kind: "review" },
      ];

      const observed: Record<string, unknown>[] = [];
      const rows: WorkflowRow[] = [];
      let currentTag = "setup";
      const tracker = new ProcessTracker();
      tracker.start(() => currentTag);
      const t0 = Date.now();
      for (let i = 0; i < N; i++) {
        const step = plan[i]!;
        const started = Date.now();
        currentTag = `w${i + 1}`;
        const root = freshRepo(`p${i}`);
        const { projectId } = await call<{ projectId: string }>("projects.create", {
          name: `p${i}`,
          rootPath: root,
        });
        const { workflowId } = await call<{ workflowId: string }>("workflows.create", {
          projectId,
        });
        if (step.kind === "plain") {
          await call("workflows.start", { workflowId, agentId: step.agent, prompt: PROMPT });
        } else {
          await call("workflows.startPeerReview", {
            workflowId,
            implementerAgent: "rclaude-impl",
            reviewerAgent: "rcodex",
            goal: "Create a file named hello.txt containing the single word hi. Nothing else.",
          });
        }
        // bounded wait: 4 minutes per workflow, then it counts as a hang
        const deadline = Date.now() + 240_000;
        let tasks: { id: string; state: string }[];
        let wfState: string;
        for (;;) {
          const r = await call<{ workflowState: string; tasks: { id: string; state: string }[] }>(
            "tasks.list",
            { workflowId },
          );
          tasks = r.tasks;
          wfState = r.workflowState;
          const terminal = (s: string) =>
            ["completed", "failed", "cancelled", "needs_reconciliation"].includes(s);
          const settled =
            step.kind === "plain"
              ? tasks.length > 0 && tasks.every((t) => terminal(t.state))
              : wfState === "completed" || wfState === "failed";
          if (settled) break;
          if (Date.now() > deadline) throw new Error(`workflow ${i} did not settle in 240 s`);
          await new Promise((res) => setTimeout(res, 500));
        }
        await svc.idle();
        const ms = Date.now() - started;
        await tracker.sample(currentTag);
        const orphansNow = tracker
          .survivors(await listProcesses())
          .filter((p) => CLI_NAME.test(p.name) && p.during.includes(currentTag));
        rows.push({
          n: i + 1,
          workflowId,
          kind: step.kind,
          agent: step.agent ?? "rclaude-impl+rcodex",
          workflowState: wfState,
          ms,
          taskCount: tasks.length,
          taskStates: tasks.map((t) => t.state),
          orphansAfter: orphansNow.length,
        });
        observed.push({
          i,
          kind: step.kind,
          agent: step.agent ?? "rclaude-impl+rcodex",
          workflow: wfState,
          tasks: tasks.map((t) => t.state),
          seconds: Math.round((Date.now() - started) / 100) / 10,
        });

        // consistency after EVERY workflow
        expect(
          count(
            "SELECT COUNT(*) c FROM tasks WHERE state IN ('queued','running','waiting_approval')",
          ),
          `workflow ${i}: tasks stuck non-terminal`,
        ).toBe(0);
        expect(
          count("SELECT COUNT(*) c FROM worktrees WHERE state IN ('creating','removing')"),
          `workflow ${i}: half-made worktrees`,
        ).toBe(0);
        for (const t of tasks) {
          const row = sql
            .prepare(
              "SELECT COUNT(*) n, MIN(sequence) lo, MAX(sequence) hi FROM messages WHERE task_id = ?",
            )
            .get(t.id) as { n: number; lo: number | null; hi: number | null };
          if (row.n > 0)
            expect([row.lo, row.hi], `workflow ${i} message sequence`).toEqual([0, row.n - 1]);
        }
      }
      const totalSeconds = Math.round((Date.now() - t0) / 100) / 10;
      const totalTasks = count("SELECT COUNT(*) c FROM tasks");

      // no secret in the log or in anything stored from the runs
      const stored = JSON.stringify(sql.prepare("SELECT * FROM messages").all());
      for (const needle of secretNeedles()) {
        expect(logText.includes(needle), "log contains an environment secret").toBe(false);
        expect(stored.includes(needle), "stored messages contain an environment secret").toBe(
          false,
        );
      }
      for (const re of SECRET_SHAPES) {
        expect(re.test(logText), `log matches ${re}`).toBe(false);
        expect(re.test(stored), `stored messages match ${re}`).toBe(false);
      }

      svc.close();
      svc = undefined;
      await new Promise((res) => setTimeout(res, 1500)); // let stdio grace timers and children finish
      const after = leakSensitive(handles());
      await tracker.stop();
      await tracker.sample("closed");
      const finalSurvivors = tracker
        .survivors(await listProcesses())
        .filter((p) => CLI_NAME.test(p.name));

      // vitest does not show console output of a passing run here, so the report goes to a file when asked for.
      const reportFile = process.env["AGENT_STUDIO_REAL_CLI_SOAK_OUT"];
      if (reportFile) {
        writeFileSync(
          reportFile,
          JSON.stringify({
            workflows: N,
            cliCalls: totalTasks,
            totalSeconds,
            handlesBefore: before,
            handlesAfter: after,
            processesSeen: tracker.seenCount,
            cliProcessesAliveAfterClose: finalSurvivors.length,
            cliProcessesAliveAfterCloseNames: finalSurvivors.map((p) => p.name),
            rows,
            logBytes: logText.length,
            observed,
          }),
        );
        const { dir: outDir, name: outName } = parse(reportFile);
        writeFileSync(
          join(outDir, `${outName}.md`),
          `${renderTable(rows)}

CLI processes alive after svc.close(): ${finalSurvivors.length}; descendants seen: ${tracker.seenCount}
`,
        );
      }
      expect(after, "handles after close vs before").toBeLessThanOrEqual(before + 2);
    },
    N * 300_000 + 60_000,
  );
});
