// Phase 2 e2e against the REAL Claude Code and Codex CLIs (costs tokens; never run in CI).
//   node scripts/e2e-peer-review.mjs run <implementer> <reviewer>   full Peer Review in a temp repo
//   node scripts/e2e-peer-review.mjs kill <implementer> <reviewer>  kill the process mid-run, restart on the same DB
// Needs `pnpm build` first. Prints a JSON report; exit code 1 when the expectation failed.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../packages/shared-utils/dist/index.js";
import { SidecarService } from "../services/orchestrator/dist/index.js";

const self = fileURLToPath(import.meta.url);
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => createLogger({ name: "e2e", destination: process.stderr });

let n = 0;
const open = (dbPath, worktreesDir) =>
  new SidecarService({ dbPath, worktreesDir, schedulerIntervalMs: 200 }, quiet());
const call = async (svc, method, params) => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  if ("error" in response) throw new Error(`${method}: ${response.error.message}`);
  return response.result;
};

function makeRepo(dir) {
  const root = join(dir, "project");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "e2e@example.com");
  git(root, "config", "user.name", "e2e");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, "README.md"), "demo\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

const GOAL = "Create a file named hello.txt in the current directory containing exactly: hello";

async function report(svc, workflowId) {
  const { workflowState, tasks } = await call(svc, "tasks.list", { workflowId });
  const out = { workflowState, tasks: [] };
  for (const t of tasks) {
    const logs = await call(svc, "logs.query", { taskId: t.id, afterSequence: -1, limit: 500 });
    out.tasks.push({
      agent: t.agentId,
      state: t.state,
      messages: logs.messages.length,
      last: logs.messages.at(-1)?.type,
    });
  }
  out.worktrees = (await call(svc, "worktrees.list", { workflowId })).worktrees.map((w) => w.state);
  return out;
}

async function waitSettled(svc, workflowId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { workflowState } = await call(svc, "tasks.list", { workflowId });
    if (["completed", "failed", "cancelled"].includes(workflowState)) return workflowState;
    await sleep(1000);
  }
  return "timeout";
}

async function runMode(impl, rev) {
  const dir = mkdtempSync(join(tmpdir(), "as-e2e-"));
  const svc = open(join(dir, "s.db"), join(dir, "wt"));
  try {
    const root = makeRepo(dir);
    const { projectId } = await call(svc, "projects.create", { name: "e2e", rootPath: root });
    const { workflowId } = await call(svc, "workflows.create", { projectId });
    const t0 = Date.now();
    await call(svc, "workflows.startPeerReview", {
      workflowId,
      implementerAgent: impl,
      reviewerAgent: rev,
      goal: GOAL,
    });
    const final = await waitSettled(svc, workflowId, 600_000);
    const rep = await report(svc, workflowId);
    const first = rep.tasks[0];
    let diff = "";
    if (first) {
      const id = (await call(svc, "tasks.list", { workflowId })).tasks[0].id;
      diff = (await call(svc, "artifacts.diff", { taskId: id })).patch;
    }
    const board = (await call(svc, "context.list", { workflowId })).items.map((i) => i.kind);
    console.log(
      JSON.stringify(
        {
          mode: "run",
          final,
          seconds: (Date.now() - t0) / 1000,
          ...rep,
          diff,
          board,
          mainClean: git(root, "status", "--porcelain") === "",
        },
        null,
        2,
      ),
    );
    process.exitCode = final === "completed" && diff.includes("+hello") ? 0 : 1;
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function twoMode(impl, rev) {
  const dir = mkdtempSync(join(tmpdir(), "as-e2e-two-"));
  const svc = open(join(dir, "s.db"), join(dir, "wt"));
  try {
    const root = makeRepo(dir);
    const { projectId } = await call(svc, "projects.create", { name: "e2e", rootPath: root });
    const ids = [];
    for (const file of ["one.txt", "two.txt"]) {
      const { workflowId } = await call(svc, "workflows.create", { projectId });
      await call(svc, "workflows.startPeerReview", {
        workflowId,
        implementerAgent: impl,
        reviewerAgent: rev,
        goal: `Create a file named ${file} in the current directory containing exactly: ${file}`,
      });
      ids.push(workflowId);
    }
    const finals = [];
    for (const id of ids) finals.push(await waitSettled(svc, id, 600_000));
    const wts = [];
    const diffs = [];
    for (const id of ids) {
      wts.push(
        ...(await call(svc, "worktrees.list", { workflowId: id })).worktrees.map((w) => w.path),
      );
      const t = (await call(svc, "tasks.list", { workflowId: id })).tasks[0];
      diffs.push((await call(svc, "artifacts.diff", { taskId: t.id })).patch);
    }
    const separate =
      new Set(wts).size === 2 &&
      diffs[0].includes("+one.txt") &&
      !diffs[0].includes("two.txt") &&
      diffs[1].includes("+two.txt") &&
      !diffs[1].includes("one.txt");
    console.log(
      JSON.stringify(
        {
          mode: "two",
          finals,
          worktrees: wts.length,
          separate,
          mainClean: git(root, "status", "--porcelain") === "",
        },
        null,
        2,
      ),
    );
    process.exitCode = finals.every((f) => f === "completed") && separate ? 0 : 1;
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function killMode(impl, rev) {
  const dir = mkdtempSync(join(tmpdir(), "as-e2e-kill-"));
  const dbPath = join(dir, "s.db");
  const wt = join(dir, "wt");
  const root = makeRepo(dir);
  const child = spawn(process.execPath, [self, "_victim", impl, rev, dbPath, wt, root], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let workflowId = "";
  await new Promise((resolve) => {
    child.stdout.on("data", (b) => {
      const m = /WF (\S+)/.exec(String(b));
      if (m) {
        workflowId = m[1];
        resolve();
      }
    });
  });
  // Wait until the implementer is really running, then kill the whole process abruptly.
  const probe = open(dbPath, wt);
  let running = false;
  for (let i = 0; i < 120 && !running; i++) {
    const { tasks } = await call(probe, "tasks.list", { workflowId });
    running = tasks.some((t) => t.state === "running");
    if (!running) await sleep(500);
  }
  probe.close();
  child.kill("SIGKILL");
  await sleep(1000);
  const svc = open(dbPath, wt); // restart on the same database
  try {
    const rep = await report(svc, workflowId);
    const reran = await (async () => {
      await sleep(3000);
      return (await report(svc, workflowId)).tasks.length;
    })();
    console.log(
      JSON.stringify({ mode: "kill", sawRunning: running, ...rep, tasksAfterWait: reran }, null, 2),
    );
    const t = rep.tasks[0];
    process.exitCode =
      running && t && t.state === "needs_reconciliation" && reran === rep.tasks.length ? 0 : 1;
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function victim(impl, rev, dbPath, wt, root) {
  const svc = open(dbPath, wt);
  const { projectId } = await call(svc, "projects.create", { name: "e2e", rootPath: root });
  const { workflowId } = await call(svc, "workflows.create", { projectId });
  await call(svc, "workflows.startPeerReview", {
    workflowId,
    implementerAgent: impl,
    reviewerAgent: rev,
    goal: GOAL,
  });
  console.log(`WF ${workflowId}`);
  await sleep(10 * 60_000);
}

const [mode, a, b, c, d, e] = process.argv.slice(2);
if (mode === "run") await runMode(a, b);
else if (mode === "two") await twoMode(a, b);
else if (mode === "kill") await killMode(a, b);
else if (mode === "_victim") await victim(a, b, c, d, e);
else console.error("usage: e2e-peer-review.mjs run|kill <implementer> <reviewer>");
void dirname;
