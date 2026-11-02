import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import { validateEventStream, type AgentTask } from "@agent-studio/agent-core";
import { describeAdapterContract } from "./adapter-contract.js";
import { ClaudeAdapter, parseClaudeLine } from "@agent-studio/adapter-claude";

const fake = fileURLToPath(
  new URL("../../packages/adapter-claude/test/fake-claude.mjs", import.meta.url),
);
const fixture = fileURLToPath(
  new URL("../contracts/fixtures/claude/2.1.314/print-stream-json.jsonl", import.meta.url),
);
const make = (mode = "ok", extra: Record<string, unknown> = {}) =>
  new ClaudeAdapter({
    command: process.execPath,
    baseArgs: [fake],
    env: { ...process.env, FAKE_MODE: mode },
    ...extra,
  });
const task = (prompt = "hi", signal = new AbortController().signal, id = "t1"): AgentTask => ({
  id,
  prompt,
  cwd: process.cwd(),
  signal,
});
async function run(a: ClaudeAdapter, t: AgentTask, onEach?: (e: AgentEvent, i: number) => void) {
  const out: AgentEvent[] = [];
  for await (const e of a.execute(t)) {
    onEach?.(e, out.length);
    out.push(e);
  }
  return out;
}

describeAdapterContract("claude (fake CLI)", { make: () => make() });

describe("parseClaudeLine on the REAL 2.1.314 fixture", () => {
  const lines = readFileSync(fixture, "utf8").trim().split("\n");
  const parsed = lines.map(parseClaudeLine);
  it("maps assistant text and the budget error result; init is ignored", () => {
    expect(parsed.flatMap((p) => p.events).filter((e) => e.type === "text")).toEqual([
      { type: "text", content: "ok" },
    ]);
    const final = parsed.find((p) => p.final)?.final;
    expect(final).toMatchObject({ type: "error" });
    expect(final?.type === "error" && final.message).toContain("Reached maximum budget");
  });
  it("ignores junk, unknown types and non-objects", () => {
    for (const l of ["", "not json", "[]", "42", '{"type":"system","subtype":"hook_started"}']) {
      expect(parseClaudeLine(l)).toEqual({ events: [] });
    }
  });
});

const toolFixture = fileURLToPath(
  new URL("../contracts/fixtures/claude/2.1.314/print-stream-json-tool.jsonl", import.meta.url),
);
describe("parseClaudeLine on the REAL tool-use fixture (2.1.314)", () => {
  it("maps tool_use -> tool_call, tool_result -> tool_result, text, and a successful result", () => {
    const parsed = readFileSync(toolFixture, "utf8").trim().split("\n").map(parseClaudeLine);
    const events = parsed.flatMap((p) => p.events);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text", "usage"]);
    expect(events[0]).toMatchObject({ type: "tool_call", name: "Read" });
    expect(events[1]).toEqual({ type: "tool_result", result: "1\tagent-studio-probe-42\n2\t" });
    expect(parsed.find((p) => p.final)?.final).toEqual({
      type: "completed",
      sessionId: "00000000-0000-0000-0000-000000000000",
    });
  });
});

describe("ClaudeAdapter", () => {
  it("streams text then completed with the session id, and drops anything after the result", async () => {
    const events = await run(make(), task());
    expect(validateEventStream(events)).toEqual([]);
    expect(events[0]).toEqual({ type: "text", content: "ok" });
    expect(events.at(-1)).toEqual({ type: "completed", sessionId: "sess-1" });
    expect(JSON.stringify(events)).not.toContain("late");
  });
  it("passes the prompt on stdin untouched (not argv, no shell)", async () => {
    const nasty = '--flag "$HOME" & echo pwned\nline2';
    const events = await run(make("echo"), task(nasty));
    expect(events[0]).toEqual({ type: "text", content: nasty });
  });
  it("maps tool_use / tool_result (shape ASSUMED, see ASSUMPTIONS)", async () => {
    const events = await run(make("tools"), task());
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text", "completed"]);
    expect(events[0]).toEqual({ type: "tool_call", name: "Read", args: { file_path: "a.txt" } });
  });
  it("adds --resume for a known session and the configured extra flags", async () => {
    const t = { ...task(), sessionId: "abc" };
    const events = await run(make("args", { extraArgs: ["--strict-mcp-config"] }), t);
    const argv = JSON.parse((events[0] as { content: string }).content) as string[];
    expect(argv).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--resume",
      "abc",
      "--strict-mcp-config",
    ]);
  });
  it("safe mode can be turned off", async () => {
    const events = await run(make("args", { safeMode: false }), task());
    const argv = JSON.parse((events[0] as { content: string }).content) as string[];
    expect(argv).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
  });
  it("kills a hanging run on abort and reports cancelled", async () => {
    const ac = new AbortController();
    const events = await run(make("hang"), task("x", ac.signal), (e) => {
      if (e.type === "text") ac.abort();
    });
    expect(events.at(-1)).toEqual({ type: "error", message: "cancelled" });
    expect(validateEventStream(events)).toEqual([]);
  });
  it("cancel(taskId) stops a running task", async () => {
    const a = make("hang");
    const events = await run(a, task(), (e) => {
      if (e.type === "text") void a.cancel("t1");
    });
    expect(events.at(-1)).toEqual({ type: "error", message: "cancelled" });
  });
  it("a crash without a result becomes an error with the exit code and stderr tail", async () => {
    const events = await run(make("crash"), task());
    const last = events.at(-1);
    expect(last?.type === "error" && last.message).toMatch(/code 3.*without a result.*boom/s);
  });
  it("a missing CLI is an error event, detect() is false, and nothing throws", async () => {
    const a = new ClaudeAdapter({ command: "definitely-not-a-real-cli-xyz" });
    expect(await a.detect()).toBe(false);
    const events = await run(a, task());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
  });
  it("detect() is true when the command resolves; capabilities are limited to what is verified", async () => {
    expect(await make().detect()).toBe(true);
    expect(await make().capabilities()).toEqual([
      "streaming",
      "structured_output",
      "tool_execution",
      "session_resume",
    ]);
  });
});
