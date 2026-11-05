import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import { parseClaudeLine } from "./parse.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");

const denials = (name: string) =>
  fixture(name)
    .flatMap((l) => parseClaudeLine(l).events)
    .filter(
      (e): e is Extract<AgentEvent, { type: "permission_denied" }> =>
        e.type === "permission_denied",
    );

describe("permission denials from recorded claude streams", () => {
  it("a write nobody could approve is reported twice (system line, then result) with the same callId", () => {
    const found = denials("claude-write-noprompt.stream.jsonl");
    expect(found).toHaveLength(2);
    for (const d of found) {
      expect(d.toolName).toBe("Write");
      expect(d.callId).toBe("toolu-8");
    }
    // Only the result carries the input the gate compares against the worktree.
    expect(found.some((d) => d.input !== undefined)).toBe(true);
  });

  it("keeps the CLI's reason for a read outside the working directories", () => {
    const found = denials("claude-read-outside.stream.jsonl");
    expect(found.map((d) => d.toolName)).toEqual(["Read", "Read"]);
    expect(found[0]?.reason).toContain("outside allowed working directories");
  });

  it("a run with no denials reports none", () => {
    expect(denials("claude-bash.stream.jsonl")).toEqual([]);
  });

  it("the result line yields the denials as events and the end of the run as final", () => {
    const line = fixture("claude-write.stream.jsonl").find((l) => l.includes('"type":"result"'))!;
    const parsed = parseClaudeLine(line);
    expect(parsed.events[0]?.type).toBe("permission_denied");
    expect(parsed.final?.type).toBe("completed");
  });

  it("a denial without a tool name still produces an event", () => {
    const { events } = parseClaudeLine(
      JSON.stringify({ type: "system", subtype: "permission_denied" }),
    );
    expect(events).toEqual([{ type: "permission_denied", toolName: "unknown" }]);
  });
});
