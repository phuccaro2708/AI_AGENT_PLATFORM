// Bundles the sidecar entry point into one ESM file. Shared by scripts/build-sidecar.mjs (the packaged
// sidecar folder) and the process tests, so the hand-written alias table lives in exactly one place.
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function bundleSidecar(outfile) {
  const root = repoRoot;
  await build({
    entryPoints: [join(root, "services/orchestrator/src/sidecar-main.ts")],
    outfile,
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
      "@agent-studio/adapter-ollama": join(root, "packages/adapter-ollama/src/index.ts"),
      "@agent-studio/resource-monitor": join(root, "packages/resource-monitor/src/index.ts"),
      "@agent-studio/diagnostics": join(root, "packages/diagnostics/src/index.ts"),
      "@agent-studio/policy-engine": join(root, "packages/policy-engine/src/index.ts"),
    },
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: "warning",
  });
}
