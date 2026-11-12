// Batch "Claude writes, Codex reviews" over a list of tasks, one git worktree + branch per task.
//   node scripts/batch-review.mjs <project-dir> <tasks.json> [--rounds 2] [--budget 2] [--dry-run]
// tasks.json: [{ "id": "add-hello", "prompt": "Create hello.txt containing hello" }, ...]
// Needs `pnpm build` first. Calls the REAL CLIs and costs tokens, except with --dry-run (prints argv only).
// Each task ends on branch batch/<stamp>/<id>; nothing is merged into your branch. Report: <git-dir>/batch-review/<stamp>/.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeAdapter } from "../packages/adapter-claude/dist/index.js";
import { CodexAdapter } from "../packages/adapter-codex/dist/index.js";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function parseArgs(argv) {
  const [project, tasksFile, ...rest] = argv;
  if (!project || !tasksFile) {
    console.error(
      "usage: node scripts/batch-review.mjs <project-dir> <tasks.json> [--rounds N] [--budget USD] [--dry-run]",
    );
    process.exit(2);
  }
  const opt = { project: resolve(project), tasksFile, rounds: 2, budget: "2", dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--rounds") opt.rounds = Number(rest[++i]);
    else if (rest[i] === "--budget") opt.budget = rest[++i];
    else if (rest[i] === "--dry-run") opt.dryRun = true;
    else throw new Error(`unknown flag ${rest[i]}`);
  }
  if (!Number.isInteger(opt.rounds) || opt.rounds < 1)
    throw new Error("--rounds must be a positive integer");
  return opt;
}

function loadTasks(file) {
  const tasks = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(tasks)) throw new Error("tasks.json must be an array");
  for (const t of tasks) {
    if (typeof t.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(t.id))
      throw new Error(`bad task id: ${t.id}`);
    if (typeof t.prompt !== "string" || !t.prompt.trim())
      throw new Error(`task ${t.id}: empty prompt`);
  }
  return tasks;
}

/** Runs one adapter task and returns its text output plus any error events. */
async function run(adapter, task) {
  const text = [];
  const errors = [];
  for await (const e of adapter.execute({ ...task, signal: new AbortController().signal })) {
    if (e.type === "text") text.push(e.content);
    else if (e.type === "error") errors.push(e.message);
  }
  return { text: text.join("\n"), errors };
}

const writerPrompt = (task, feedback) =>
  feedback
    ? `${task.prompt}\n\nA reviewer looked at your previous attempt (already committed in this folder) and asked for changes:\n\n${feedback}\n\nFix what the review asks for. Edit files only inside the current folder.`
    : `${task.prompt}\n\nEdit files only inside the current folder.`;

const reviewPrompt = (task, diff) =>
  `You are reviewing a change made by another agent. Do not edit any file.\n\nThe task was:\n${task.prompt}\n\nThe diff:\n\`\`\`diff\n${diff}\n\`\`\`\n\nList concrete problems (correctness, missing parts of the task, broken code). Be brief.\nYour LAST line must be exactly one of:\nVERDICT: APPROVE\nVERDICT: CHANGES`;

/**
 * Turns the reviewer's free text into a decision the loop can act on.
 * Returns "approve" (task is done), "changes" (send the review back to Claude for another round)
 * or "unknown" (stop and let a human read it).
 *
 * Only the last non-empty line counts (a verdict quoted mid-text is ignored); markdown decoration around it
 * (`**`, backticks, `>`, `#`) and letter case are tolerated. Anything else is "unknown", never a guess.
 */
export function parseVerdict(reviewText) {
  const last = reviewText
    .split(/\r?\n/)
    .map((l) => l.replace(/[*_`>#]/g, "").trim())
    .filter(Boolean)
    .at(-1);
  const m = /^verdict:\s*(approve|changes)\.?$/i.exec(last ?? "");
  return m ? m[1].toLowerCase() : "unknown";
}

async function runTask(task, opt, stamp, claude, codex) {
  const branch = `batch/${stamp}/${task.id}`;
  const wt = join(tmpdir(), `agent-batch-${stamp}`, task.id);
  const base = git(opt.project, "rev-parse", "HEAD");
  git(opt.project, "worktree", "add", "-q", "-b", branch, wt, base);

  const result = { id: task.id, branch, worktree: wt, rounds: [], status: "running" };
  let feedback;
  for (let r = 1; r <= opt.rounds; r++) {
    const round = { round: r };
    result.rounds.push(round);

    const w = await run(claude, {
      id: `${task.id}-w${r}`,
      prompt: writerPrompt(task, feedback),
      cwd: wt,
      permissions: "workspace-write",
    });
    round.writerErrors = w.errors;
    round.writerSummary = w.text.slice(-2000);
    git(wt, "add", "-A");
    if (!git(wt, "diff", "--cached", "--name-only")) {
      result.status = r === 1 ? "no_changes" : "writer_made_no_fix";
      break;
    }
    git(
      wt,
      "-c",
      "user.name=batch-review",
      "-c",
      "user.email=batch-review@localhost",
      "commit",
      "-q",
      "-m",
      `batch(${task.id}): round ${r}`,
    );
    const diff = git(wt, "diff", `${base}..HEAD`);
    round.filesChanged = git(wt, "diff", "--name-only", `${base}..HEAD`).split("\n");

    const rv = await run(codex, {
      id: `${task.id}-r${r}`,
      prompt: reviewPrompt(task, diff),
      cwd: wt,
      permissions: "read-only",
    });
    round.reviewErrors = rv.errors;
    round.review = rv.text;
    // `-s read-only` does not stop writes inside cwd on this machine (docs/ASSUMPTIONS.md): detect, never trust.
    if (git(wt, "status", "--porcelain")) {
      result.status = "needs_reconciliation";
      round.note = "reviewer changed files; worktree left as-is for you to inspect";
      break;
    }
    round.verdict = parseVerdict(rv.text);
    if (round.verdict === "approve") {
      result.status = "approved";
      break;
    }
    if (round.verdict === "unknown") {
      result.status = "needs_human";
      break;
    }
    feedback = rv.text;
    if (r === opt.rounds) result.status = "out_of_rounds";
  }

  if (result.status !== "needs_reconciliation") git(opt.project, "worktree", "remove", wt);
  return result;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(opt.tasksFile);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const claude = new ClaudeAdapter({ extraArgs: ["--max-budget-usd", opt.budget] });
  const codex = new CodexAdapter({ sandbox: "read-only" });

  if (opt.dryRun) {
    const probe = { id: "x", prompt: "", cwd: opt.project, signal: new AbortController().signal };
    console.log("claude:", claude.describeLaunch({ ...probe, permissions: "workspace-write" }));
    console.log("codex: ", codex.describeLaunch({ ...probe, permissions: "read-only" }));
    console.log("tasks: ", tasks.map((t) => t.id).join(", "));
    return;
  }
  if (git(opt.project, "status", "--porcelain", "--untracked-files=no")) {
    console.error(
      "warning: project has uncommitted changes; tasks start from HEAD and will not see them",
    );
  }

  const results = [];
  for (const task of tasks) {
    console.error(`[${task.id}] start`);
    try {
      results.push(await runTask(task, opt, stamp, claude, codex));
    } catch (err) {
      results.push({ id: task.id, status: "failed", error: String(err?.message ?? err) });
    }
    console.error(`[${task.id}] ${results.at(-1).status}`);
  }

  const outDir = join(
    resolve(opt.project, git(opt.project, "rev-parse", "--git-common-dir")),
    "batch-review",
    stamp,
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(results, null, 2));
  const lines = results.map(
    (r) => `- ${r.id}: **${r.status}**${r.branch ? ` (\`${r.branch}\`)` : ""}`,
  );
  writeFileSync(join(outDir, "report.md"), `# Batch ${stamp}\n\n${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`report: ${outDir}`);
  process.exitCode = results.every((r) => r.status === "approved") ? 0 : 1;
}

// Run only when executed directly, so tests can import parseVerdict without starting a batch.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
