// ADR-001 spike driver: verifies startup, IPC, StubAdapter, SQLite persistence and cleanup.
// Copies sidecar-dist to an isolated temp dir first, so nothing can be resolved from the repo's node_modules.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "services/orchestrator/sidecar-dist");
const work = mkdtempSync(join(tmpdir(), "agent-studio-spike-"));
const dist = join(work, "sidecar");
cpSync(src, dist, { recursive: true });
const nodeBin = join(dist, process.platform === "win32" ? "node.exe" : "node");
const dbPath = join(work, "spike.db");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitDead = async (pid, ms = 5000) => {
  const t = Date.now();
  while (alive(pid) && Date.now() - t < ms) await sleep(50);
  return !alive(pid);
};

function start() {
  const child = spawn(
    nodeBin,
    [
      join(dist, "sidecar.mjs"),
      "--db",
      dbPath,
      "--sqlite-binding",
      join(dist, "better_sqlite3.node"),
      "--migrations",
      join(dist, "drizzle"),
    ],
    { cwd: work, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolveCall, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
      pending.set(myId, (m) => {
        clearTimeout(timer);
        resolveCall(m);
      });
      child.stdin.write(JSON.stringify({ id: myId, method, ...(params ? { params } : {}) }) + "\n");
    });
  const exited = new Promise((r) => child.on("exit", (code, sig) => r({ code, sig })));
  return { child, call, exited, stderr: () => stderr };
}

try {
  // 1. startup + IPC
  const t0 = Date.now();
  const a = start();
  const h = await a.call("health");
  check(
    "startup + health over stdio IPC",
    !!h.result?.pid,
    `pid=${h.result?.pid} node=${h.result?.node} sqlite=${h.result?.sqlite} ms=${Date.now() - t0}`,
  );
  check(
    "SQLite WAL enabled in sidecar",
    h.result?.journalMode === "wal",
    `journal_mode=${h.result?.journalMode}`,
  );
  check(
    "runs from isolated dir with bundled node",
    h.result?.pid !== process.pid && !existsSync(join(work, "node_modules")),
  );
  const bad = await a.call("nope");
  check("invalid request yields error response (no crash)", !!bad.error && alive(a.child.pid));

  // 2. StubAdapter execution + persistence
  const run = await a.call("runStub", { prompt: "spike" });
  check(
    "StubAdapter task completes",
    run.result?.finalState === "completed",
    JSON.stringify(run.result),
  );
  const taskId = run.result?.taskId;

  // 3. clean shutdown via protocol
  const pidA = a.child.pid;
  await a.call("shutdown");
  const ex = await a.exited;
  check(
    "shutdown request exits process with code 0",
    ex.code === 0,
    `code=${ex.code} sig=${ex.sig}`,
  );
  check("process gone after shutdown", await waitDead(pidA));

  // 4. persistence across restart (second process, same DB)
  const b = start();
  const q = await b.call("queryTask", { taskId });
  check(
    "task persisted across sidecar restart",
    q.result?.state === "completed" && q.result?.messageCount > 0,
    JSON.stringify(q.result),
  );

  // 5. cleanup when parent closes stdin (orphan prevention)
  const pidB = b.child.pid;
  b.child.stdin.end();
  const ex2 = await b.exited;
  check(
    "closing stdin exits sidecar (no orphan)",
    ex2.code === 0 && (await waitDead(pidB)),
    `code=${ex2.code}`,
  );

  // 6. cleanup when parent kills it (hard kill)
  const c = start();
  const hc = await c.call("health");
  const pidC = hc.result.pid;
  c.child.kill();
  await c.exited;
  check("killed sidecar leaves no process", await waitDead(pidC));

  // 7. DB files remain readable after hard kill (WAL recovery)
  const d = start();
  const qd = await d.call("queryTask", { taskId });
  check("DB intact after hard kill", qd.result?.state === "completed");
  d.child.stdin.end();
  await d.exited;
} catch (e) {
  check("spike driver ran without exception", false, String(e));
} finally {
  const failed = results.filter((r) => !r.ok);
  if (process.env.SPIKE_REPORT)
    writeFileSync(
      process.env.SPIKE_REPORT,
      JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2),
    );
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
