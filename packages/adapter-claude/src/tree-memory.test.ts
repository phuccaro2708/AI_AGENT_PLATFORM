import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@agent-studio/contracts";
import { ClaudeAdapter } from "./adapter.js";

/** P4-4 (b): a CLI whose process tree grows past the limit is killed and the run ends with a clear error. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ClaudeAdapter treeMemoryLimitMb", () => {
  it("stops a (fake) CLI that holds more memory than the limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-tm-"));
    dirs.push(dir);
    const script = join(dir, "hog.mjs");
    writeFileSync(
      script,
      "const b = Buffer.alloc(200 * 1024 * 1024, 1); setInterval(() => { b[0]++; }, 200);\n",
    );
    const adapter = new ClaudeAdapter({
      command: process.execPath,
      baseArgs: [script],
      treeMemoryLimitMb: 120,
    });
    const events: AgentEvent[] = [];
    for await (const e of adapter.execute({
      id: "t-tm",
      prompt: "p",
      cwd: dir,
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(JSON.stringify(last)).toMatch(/claude stopped: process tree uses \d+ MB, limit 120 MB/);
  }, 60_000);
});
