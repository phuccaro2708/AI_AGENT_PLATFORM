// CI check: do the status docs still agree with git and with each other? (deterministic, no dependencies)
//
// It does NOT rewrite anything and does NOT call a model. It is the mechanical half of the `/save sync` skill:
// when it fails, a person (or a Claude session running `/save`) updates docs/HANDOFF.md, docs/PROGRESS.md,
// docs/TODO.md and docs/ROADMAP.md. Checks:
//   1. HANDOFF has a "Cập nhật: YYYY-MM-DD" line and that date is >= the newest dated heading in PROGRESS.
//   2. PROGRESS has an entry dated on or after the newest commit date that changed code (outside docs/).
//   3. HANDOFF/PROGRESS were touched recently relative to code: at most MAX_CODE_COMMITS_BEHIND commits that
//      changed code outside docs/ since the last commit that changed docs/HANDOFF.md.
//   4. Every `docs/<file>.md` mentioned in HANDOFF exists.
//   5. Short commit hashes cited in HANDOFF's first section exist (WARNING only: a shallow clone or another
//      branch may legitimately not have them).
// Usage: node scripts/docs-sync-check.mjs [--max-behind N]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const argIdx = process.argv.indexOf("--max-behind");
const MAX_CODE_COMMITS_BEHIND = argIdx > 0 ? Number(process.argv[argIdx + 1]) : 25;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
process.chdir(root);

const errors = [];
const warnings = [];
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

const handoff = read("docs/HANDOFF.md");
const progress = read("docs/PROGRESS.md");
if (handoff === undefined || progress === undefined) {
  console.error("docs-sync-check: docs/HANDOFF.md or docs/PROGRESS.md is missing");
  process.exit(1);
}

// 1. dates
const handoffDate = /^Cập nhật:\s*(\d{4}-\d{2}-\d{2})/m.exec(handoff)?.[1];
if (!handoffDate) errors.push("docs/HANDOFF.md has no 'Cập nhật: YYYY-MM-DD' line");
const progressDates = [...progress.matchAll(/^#{2,3}\s+(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
const newestProgress = progressDates.sort().at(-1);
if (!newestProgress) errors.push("docs/PROGRESS.md has no dated heading");
if (handoffDate && newestProgress && handoffDate < newestProgress) {
  errors.push(
    `HANDOFF is dated ${handoffDate} but PROGRESS has an entry dated ${newestProgress}: refresh HANDOFF (run /save)`,
  );
}

// 2 + 3. code vs docs. `:(exclude)docs` keeps documentation-only commits out of the "code" count.
const codeLog = git("log", "--format=%H %cs", "--", ".", ":(exclude)docs", ":(exclude)*.md")
  .split("\n")
  .filter(Boolean);
if (codeLog.length > 0 && newestProgress) {
  const newestCodeDate = codeLog[0].split(" ")[1];
  if (newestProgress < newestCodeDate) {
    errors.push(
      `newest code commit is ${newestCodeDate} but PROGRESS stops at ${newestProgress}: record the work (run /save)`,
    );
  }
}
const lastHandoffCommit = git("log", "-1", "--format=%H", "--", "docs/HANDOFF.md");
if (lastHandoffCommit) {
  const behind = git(
    "rev-list",
    "--count",
    `${lastHandoffCommit}..HEAD`,
    "--",
    ".",
    ":(exclude)docs",
    ":(exclude)*.md",
  );
  if (Number(behind) > MAX_CODE_COMMITS_BEHIND) {
    errors.push(
      `${behind} code commits since docs/HANDOFF.md last changed (limit ${MAX_CODE_COMMITS_BEHIND}): run /save`,
    );
  }
}

// 4. referenced docs exist
for (const m of new Set(
  [...handoff.matchAll(/`(docs\/[A-Za-z0-9_./-]+\.md)(?:#[^`]*)?`/g)].map((x) => x[1]),
)) {
  if (!existsSync(m)) errors.push(`HANDOFF cites ${m}, which does not exist`);
}

// 5. hashes in the first section (up to the second "## " heading)
const head = handoff.split(/^## /m).slice(0, 2).join("## ");
for (const h of new Set([...head.matchAll(/`([0-9a-f]{7,40})`/g)].map((x) => x[1]))) {
  try {
    git("cat-file", "-e", `${h}^{commit}`);
  } catch {
    warnings.push(
      `HANDOFF cites commit ${h}, not found in this clone (shallow or another branch?)`,
    );
  }
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`DRIFT ${e}`);
if (errors.length > 0) {
  console.error(
    `docs-sync-check: ${errors.length} problem(s). Update docs/HANDOFF.md, PROGRESS.md, TODO.md, ROADMAP.md (the /save skill does this) and commit.`,
  );
  process.exit(1);
}
console.log(
  `docs-sync-check: OK (HANDOFF ${handoffDate}, PROGRESS ${newestProgress}, ${warnings.length} warning(s))`,
);
