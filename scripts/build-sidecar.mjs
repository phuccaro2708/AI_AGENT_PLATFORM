// Builds a self-contained sidecar folder (ADR-001 spike):
//   sidecar-dist/{node(.exe), sidecar.mjs, better_sqlite3.node, drizzle/}
// The folder has no node_modules; the bundled sidecar loads the native module by explicit path.
import { cpSync, copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleSidecar } from "./sidecar-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "services/orchestrator/sidecar-dist");
const require = createRequire(join(root, "packages/storage/package.json"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await bundleSidecar(join(out, "sidecar.mjs"));

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
