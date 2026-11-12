import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import { ClaudeAdapter } from "./adapter.js";

/** P4-4 (b): the adapter hands `jobWrap` to the process manager. An unusable wrapper stops the run (fail closed). */
describe("ClaudeAdapter jobWrap", () => {
  it("does not start the CLI when the wrapper path is unusable, and says why", async () => {
    const adapter = new ClaudeAdapter({
      command: process.execPath, // would run if the wrapper option were ignored
      baseArgs: ["-e", "console.log('{}')"],
      jobWrap: { path: "relative/agent-job-wrap.exe" },
    });
    const events: AgentEvent[] = [];
    for await (const e of adapter.execute({
      id: "t-jw",
      prompt: "p",
      cwd: process.cwd(),
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(JSON.stringify(last)).toContain("agent-job-wrap");
  });
});
