import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import { validateEventStream, type AgentTask } from "@agent-studio/agent-core";
import { describeAdapterContract } from "./adapter-contract.js";
import { CodexAdapter, createCodexParser } from "@agent-studio/adapter-codex";

const fake = fileURLToPath(
  new URL("../../packages/adapter-codex/test/fake-codex.mjs", import.meta.url),
);
const fixtureDir = new URL("../contracts/fixtures/codex/0.165.0/", import.meta.url);
const lines = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, fixtureDir)), "utf8")
    .trim()
    .split("\n");

const make = (mode = "ok", extra: Record<string, unknown> = {}) =>
  new CodexAdapter({
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
async function run(a: CodexAdapter, t: AgentTask, onEach?: (e: AgentEvent, i: number) => void) {
  const out: AgentEvent[] = [];
  for await (const e of a.execute(t)) {
    onEach?.(e, out.length);
    out.push(e);
  }
  return out;
}

describeAdapterContract("codex (fake CLI)", { make: () => make() });

describe("createCodexParser on the REAL codex-cli 0.165.0 fixtures", () => {
  it("maps a plain answer: text, usage, completed with the thread id", () => {
    const p = createCodexParser();
    const parsed = lines("exec-json-text.jsonl").map((l) => p.parse(l));
    expect(parsed.flatMap((x) => x.events)).toEqual([
      { type: "text", content: "pong" },
      {
        type: "usage",
        data: {
          input_tokens: 27170,
          cached_input_tokens: 13440,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    ]);
    expect(parsed.at(-1)?.final).toEqual({
      type: "completed",
      sessionId: "01a19d2c-5743-7522-ba87-212f4c44c141",
    });
  });

  it("pairs a command_execution start/finish into one tool_call and one tool_result", () => {
    const p = createCodexParser();
    const events = lines("exec-json-command.jsonl").flatMap((l) => p.parse(l).events);
    expect(events.map((e) => e.type)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "text",
      "usage",
    ]);
    expect(events[2]).toEqual({
      type: "tool_result",
      result: { exitCode: 0, status: "completed", output: "hi\r\n" },
    });
  });

  it("ignores junk, unknown types, reasoning and non-objects", () => {
    const p = createCodexParser();
    for (const l of [
      "",
      "not json",
      "[]",
      "42",
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"x"}}',
    ]) {
      expect(p.parse(l)).toEqual({ events: [] });
    }
  });

  it("a finished item that never started still yields call + result (so the pair balances)", () => {
    const p = createCodexParser();
    const r = p.parse('{"type":"item.completed","item":{"id":"f","type":"file_change"}}');
    expect(r.events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
  });
});

describe("CodexAdapter", () => {
  it("streams text then completed with the thread id, and drops anything after the end", async () => {
    const events = await run(make(), task());
    expect(validateEventStream(events)).toEqual([]);
    expect(events[0]).toEqual({ type: "text", content: "ok" });
    expect(events.at(-1)).toEqual({ type: "completed", sessionId: "thr-1" });
    expect(JSON.stringify(events)).not.toContain("late");
  });
  it("passes the prompt on stdin untouched (not argv, no shell)", async () => {
    const nasty = '--flag "$HOME" & echo pwned\nline2';
    const events = await run(make("echo"), task(nasty));
    expect(events[0]).toEqual({ type: "text", content: nasty });
  });
  it("maps a shell command to tool_call / tool_result", async () => {
    const events = await run(make("tools"), task());
    expect(events.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
      "text",
      "usage",
      "completed",
    ]);
    expect(events[0]).toEqual({ type: "tool_call", name: "shell", args: { command: "echo hi" } });
  });
  it("defaults to a read-only sandbox, reads the prompt from stdin, and ignores sessionId", async () => {
    const t = { ...task(), sessionId: "abc" };
    const events = await run(make("args"), t);
    const argv = JSON.parse((events[0] as { content: string }).content) as string[];
    expect(argv).toEqual(["exec", "--json", "-s", "read-only", "-"]);
  });
  it("honours workspace-write and extra flags, with '-' still last", async () => {
    const events = await run(
      make("args", { sandbox: "workspace-write", extraArgs: ["-m", "x"] }),
      task(),
    );
    const argv = JSON.parse((events[0] as { content: string }).content) as string[];
    expect(argv).toEqual(["exec", "--json", "-s", "workspace-write", "-m", "x", "-"]);
  });
  it("turn.failed becomes an error event carrying the message", async () => {
    const events = await run(make("failed"), task());
    expect(events.at(-1)).toEqual({ type: "error", message: "model not available" });
    expect(validateEventStream(events)).toEqual([]);
  });
  it("a started-but-unfinished command leaves an unmatched tool_call (-> needs_reconciliation)", async () => {
    const events = await run(make("unfinished"), task());
    const calls = events.filter((e) => e.type === "tool_call").length;
    const results = events.filter((e) => e.type === "tool_result").length;
    expect(calls).toBe(1);
    expect(results).toBe(0);
    expect(events.at(-1)?.type).toBe("error");
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
    const a = new CodexAdapter({ command: "definitely-not-a-real-cli-xyz" });
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
    ]);
  });
});
