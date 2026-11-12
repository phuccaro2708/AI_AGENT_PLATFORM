// A3 driver (opt-in real-CLI check, Windows only; see real-cli-gates.test.ts "claude-signals").
// Runs in its OWN hidden console (the test starts it through `Start-Process`), so a console Ctrl+C reaches only the
// processes of this run. It starts the bundled sidecar (optionally inside an outer `agent-job-wrap`, standing in for
// the desktop app's Job Object), starts ONE real claude/codex task through the sidecar's stdio protocol, waits until
// the CLI is running, then either sends a real console Ctrl+C or hard-kills the sidecar (or its outer wrapper), and
// reports which processes of the captured tree are still alive afterwards. Result: JSON file named in the config.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { bundle, sqliteBinding, migrations, outerWrap, dir, cli, mode, out, procTools } = cfg;
const result = { cli, mode, outerWrap: Boolean(outerWrap), steps: [] };
const step = (s) => result.steps.push(`${new Date().toISOString().slice(11, 23)} ${s}`);
const save = () => writeFileSync(out, JSON.stringify(result, null, 2));
process.on("SIGINT", () => step("driver ignored SIGINT"));
process.on("SIGBREAK", () => step("driver ignored SIGBREAK"));

const ps = (action, arg = "") =>
  execFileSync("pwsh", ["-NoProfile", "-File", procTools, action, arg], {
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
  }).trim();
const json = (t) => {
  if (t === "") return [];
  const v = JSON.parse(t);
  return Array.isArray(v) ? v : [v];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(join(dir, "data"), { recursive: true });
const repo = join(dir, "proj");
mkdirSync(repo, { recursive: true });
for (const a of [
  ["init", "-q", "-b", "main"],
  ["config", "user.email", "t@example.com"],
  ["config", "user.name", "t"],
  ["config", "core.autocrlf", "false"],
]) {
  execFileSync("git", a, { cwd: repo });
}
writeFileSync(join(repo, "README.md"), "x\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

const sidecarArgs = [
  bundle,
  "--db",
  join(dir, "data", "s.db"),
  "--sqlite-binding",
  sqliteBinding,
  "--migrations",
  migrations,
  ...(cfg.jobWrap ? ["--job-wrap", cfg.jobWrap] : []),
];
const outer = outerWrap ? [outerWrap, "--", process.execPath, ...sidecarArgs] : undefined;
const top = spawn(outer ? outer[0] : process.execPath, outer ? outer.slice(1) : sidecarArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  env: { ...process.env, ANTHROPIC_MODEL: "haiku" },
});
step(`top pid ${top.pid}`);
let err = "";
top.stderr.on("data", (d) => (err += d));
const pending = new Map();
createInterface({ input: top.stdout }).on("line", (line) => {
  try {
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)(m);
  } catch {
    /* event line */
  }
});
let exitCode = "running";
const exited = new Promise((r) =>
  top.once("exit", (c, s) => {
    exitCode = c === null ? `signal:${s}` : c;
    r();
  }),
);
let nextId = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    top.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n");
  });

try {
  for (let i = 0; i < 120 && !err.includes("sidecar ready"); i++) await sleep(250);
  if (!err.includes("sidecar ready")) throw new Error(`sidecar not ready: ${err.slice(-400)}`);
  const { projectId } = await call("projects.create", { name: "sig", rootPath: repo });
  const { workflowId } = await call("workflows.create", { projectId });
  await call("workflows.start", {
    workflowId,
    agentId: cli,
    prompt:
      "Write a long essay of at least 5000 words about rivers, one paragraph at a time. Do not use any tools.",
  });
  step("task started");
  // Wait until the CLI program is in the tree.
  let tree = [];
  const cliName = new RegExp(`^${cli}(\\.exe)?$`, "i");
  for (let i = 0; i < 90; i++) {
    tree = json(ps("tree", String(top.pid)));
    if (tree.some((p) => cliName.test(p.name))) break;
    await sleep(1000);
  }
  if (!tree.some((p) => cliName.test(p.name))) throw new Error("CLI never appeared in the tree");
  await sleep(6000); // let it generate text and grow its tree
  tree = json(ps("tree", String(top.pid)));
  const { tasks } = await call("tasks.list", { workflowId });
  result.taskStateBefore = tasks.map((t) => t.state ?? t.status);
  result.treeBefore = tree.map((p) => `${p.pid}:${p.name}`);
  step(`tree captured: ${tree.length} processes; task states ${result.taskStateBefore.join(",")}`);

  if (mode === "ctrlc") {
    step(`ctrl+c: ${ps("ctrlc")}`);
  } else {
    top.kill(); // TerminateProcess on Windows
    step("top process killed");
  }
  await Promise.race([exited, sleep(30_000)]);
  result.topExit = exitCode;
  step(`top exit: ${exitCode}`);
  await sleep(5000);
  const specs = tree.map((p) => `${p.pid}:${p.created}`).join(",");
  const left = json(ps("alive", specs));
  result.survivorsOf_tree = left.map((p) => `${p.pid}:${p.name}`);
  result.cliSurvivors = left.filter((p) => /claude|codex|node|agent-job-wrap/i.test(p.name)).length;
  step(`survivors after 5 s: ${left.length}`);
  // Clean up whatever is left so the test never leaves processes behind.
  for (const p of left) {
    try {
      process.kill(p.pid);
    } catch {
      /* gone */
    }
  }
} catch (e) {
  result.error = String(e);
  try {
    top.kill();
  } catch {
    /* gone */
  }
} finally {
  result.sidecarStderrTail = err.slice(-600);
  save();
  process.exit(0);
}
