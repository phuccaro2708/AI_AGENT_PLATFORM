// Builds a self-contained sidecar folder (ADR-001 spike):
//   sidecar-dist/{node(.exe), sidecar.mjs, better_sqlite3.node, drizzle/}
// The folder has no node_modules; the bundled sidecar loads the native module by explicit path.
import { build } from "esbuild";
import { cpSync, copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "services/orchestrator/sidecar-dist");
const require = createRequire(join(root, "packages/storage/package.json"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, "services/orchestrator/src/sidecar-main.ts")],
  outfile: join(out, "sidecar.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  alias: {
    "@agent-studio/contracts": join(root, "packages/contracts/src/index.ts"),
    "@agent-studio/shared-utils": join(root, "packages/shared-utils/src/index.ts"),
    "@agent-studio/agent-core": join(root, "packages/agent-core/src/index.ts"),
    "@agent-studio/storage": join(root, "packages/storage/src/index.ts"),
    "@agent-studio/process-manager": join(root, "packages/process-manager/src/index.ts"),
    "@agent-studio/git-worktrees": join(root, "packages/git-worktrees/src/index.ts"),
    "@agent-studio/cli-probe": join(root, "packages/cli-probe/src/index.ts"),
    "@agent-studio/adapter-claude": join(root, "packages/adapter-claude/src/index.ts"),
    "@agent-studio/adapter-codex": join(root, "packages/adapter-codex/src/index.ts"),
    "@agent-studio/adapter-antigravity": join(root, "packages/adapter-antigravity/src/index.ts"),
    "@agent-studio/resource-monitor": join(root, "packages/resource-monitor/src/index.ts"),
    "@agent-studio/policy-engine": join(root, "packages/policy-engine/src/index.ts"),
  },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});

const sqliteDir = dirname(require.resolve("better-sqlite3/package.json"));
copyFileSync(
  join(sqliteDir, "build/Release/better_sqlite3.node"),
  join(out, "better_sqlite3.node"),
);
cpSync(join(root, "packages/storage/drizzle"), join(out, "drizzle"), { recursive: true });
const nodeName = process.platform === "win32" ? "node.exe" : "node";
copyFileSync(process.execPath, join(out, nodeName));

const mb = (p) => (statSync(p).size / 1048576).toFixed(1);
console.log(`sidecar-dist: ${out}`);
console.log(
  `  ${nodeName} ${mb(join(out, nodeName))} MB, sidecar.mjs ${mb(join(out, "sidecar.mjs"))} MB, better_sqlite3.node ${mb(join(out, "better_sqlite3.node"))} MB`,
);
