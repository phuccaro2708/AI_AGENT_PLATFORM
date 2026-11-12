import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@agent-studio/contracts";
import { ClaudeAdapter } from "./adapter.js";

/** Host-side backstop: a CLI that never answers (for instance one waiting on a hung permission gate) is stopped, not retried. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ClaudeAdapter timeoutMs", () => {
  it("ends a (fake) CLI that never answers with a controlled error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-to-"));
    dirs.push(dir);
    const script = join(dir, "hang.mjs");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");
    const adapter = new ClaudeAdapter({
      command: process.execPath,
      baseArgs: [script],
      timeoutMs: 400,
    });
    const events: AgentEvent[] = [];
    for await (const e of adapter.execute({
      id: "t-to",
      prompt: "p",
      cwd: dir,
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(JSON.stringify(last)).toMatch(/time limit reached/);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  }, 30_000);
});
