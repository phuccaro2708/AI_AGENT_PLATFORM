// Phase 1 baseline (E1): sidecar cold start, idle/peak memory, and request->event latency with the
// StubAdapter. Measures the real bundled sidecar in an isolated temp dir. Numbers are a baseline for
// docs/PERF_BUDGET.md, not a pass/fail gate. Usage: node scripts/perf-baseline.mjs [--runs N] [--tasks N]
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const RUNS = arg("runs", 7);
const TASKS = arg("tasks", 30);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "agent-studio-perf-"));
const dist = join(work, "sidecar");
cpSync(join(root, "services/orchestrator/sidecar-dist"), dist, { recursive: true });
const win = process.platform === "win32";

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stat = (xs) => ({
  n: xs.length,
  min: +Math.min(...xs).toFixed(1),
  p50: +pct(xs, 50).toFixed(1),
  p95: +pct(xs, 95).toFixed(1),
  max: +Math.max(...xs).toFixed(1),
});
const rssMiB = (pid) => {
  const out = win
    ? execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
        { encoding: "utf8" },
      )
    : execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  return +((Number(out.trim()) * (win ? 1 : 1024)) / 1048576).toFixed(1);
};

function start(db) {
  const child = spawn(
    join(dist, win ? "node.exe" : "node"),
    [
      join(dist, "sidecar.mjs"),
      "--db",
      db,
      "--sqlite-binding",
      join(dist, "better_sqlite3.node"),
      "--migrations",
      join(dist, "drizzle"),
    ],
    { cwd: work, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const pending = new Map();
  const listeners = new Set();
  child.stderr.resume();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.event) for (const l of listeners) l(msg, performance.now());
    else pending.get(msg.id)?.(msg);
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((res, rej) => {
      const myId = ++id;
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000);
      pending.set(myId, (m) => {
        clearTimeout(t);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      });
      child.stdin.write(JSON.stringify({ id: myId, method, ...(params ? { params } : {}) }) + "\n");
    });
  const stop = async () => {
    const exited = new Promise((r) => child.on("exit", r));
    child.stdin.end();
    await exited;
  };
  return { child, call, listeners, stop };
}

const report = { platform: process.platform, node: process.version, runs: RUNS, tasks: TASKS };

// 1. cold start: spawn -> first health response (fresh DB each time, migrations included)
const cold = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const s = start(join(work, `cold-${i}.db`));
  await s.call("health");
  cold.push(performance.now() - t0);
  await s.stop();
}
report.coldStartMs = stat(cold);

// 2. idle memory, then event latency over TASKS stub tasks, then memory again
const s = start(join(work, "main.db"));
const health = await s.call("health");
await new Promise((r) => setTimeout(r, 1500));
report.sidecarRssIdleMiB = rssMiB(health.pid);

const { projectId } = await s.call("projects.create", { name: "perf", rootPath: work });
const { workflowId } = await s.call("workflows.create", { projectId });
const first = [];
const total = [];
const gaps = [];
for (let i = 0; i < TASKS; i++) {
  let tFirst;
  let tPrev;
  let done;
  const finished = new Promise((r) => (done = r));
  const onEvent = (m, t) => {
    if (m.event === "task.message") {
      tFirst ??= t;
      if (tPrev !== undefined) gaps.push(t - tPrev);
      tPrev = t;
    } else if (m.event === "task.state" && ["completed", "failed", "cancelled"].includes(m.state)) {
      done(t);
    }
  };
  s.listeners.add(onEvent);
  const t0 = performance.now();
  await s.call("workflows.start", { workflowId, agentId: "stub", prompt: `perf ${i}` });
  const tEnd = await finished;
  s.listeners.delete(onEvent);
  first.push(tFirst - t0);
  total.push(tEnd - t0);
}
report.stubFirstMessageMs = stat(first);
report.stubTaskTotalMs = stat(total);
report.stubInterMessageGapMs = gaps.length ? stat(gaps) : null;
report.sidecarRssAfterTasksMiB = rssMiB(health.pid);
await s.stop();

console.log(JSON.stringify(report, null, 2));
rmSync(work, { recursive: true, force: true });
