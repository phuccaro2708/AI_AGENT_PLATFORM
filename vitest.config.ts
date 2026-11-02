import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(`./${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@agent-studio/contracts": src("packages/contracts"),
      "@agent-studio/shared-utils": src("packages/shared-utils"),
      "@agent-studio/agent-core": src("packages/agent-core"),
      "@agent-studio/storage": src("packages/storage"),
      "@agent-studio/process-manager": src("packages/process-manager"),
      "@agent-studio/cli-probe": src("packages/cli-probe"),
      "@agent-studio/orchestrator": src("services/orchestrator"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "services/*/src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
