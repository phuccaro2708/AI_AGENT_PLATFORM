import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@agent-studio/contracts";
import { validateEventStream, type AgentTask } from "@agent-studio/agent-core";
import { OllamaAdapter } from "@agent-studio/adapter-ollama";
import { startFakeOllama, type FakeOllama, type ScriptStep } from "./fake-ollama.js";

let dir: string;
let server: FakeOllama;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-ollt-"));
  writeFileSync(join(dir, "notes.txt"), "project notes");
  writeFileSync(join(dir, ".env"), "TOKEN=abc");
  server = await startFakeOllama("scripted");
});
afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const make = (extra: Record<string, unknown> = {}) =>
  new OllamaAdapter({ baseUrl: server.url, model: "m", idleTimeoutMs: 2000, ...extra });
const task = (prompt = "go"): AgentTask => ({
  id: "t",
  prompt,
  cwd: dir,
  signal: new AbortController().signal,
});
async function run(a: OllamaAdapter, script: ScriptStep[], t = task()) {
  server.chats.length = 0;
  server.script = script;
  const out: AgentEvent[] = [];
  for await (const e of a.execute(t)) out.push(e);
  return out;
}
const msgs = (i: number) => server.chats[i]?.["messages"] as Record<string, unknown>[];
const lastError = (e: AgentEvent[]) => {
  const l = e.at(-1);
  return l?.type === "error" ? l.message : undefined;
};

describe("OllamaAdapter tool loop (read-only, opt-in)", () => {
  it("is off by default: no tools are offered and a stray tool_calls is ignored, not run", async () => {
    const events = await run(make(), [
      { text: "answer", toolCalls: [{ name: "read_file", arguments: { path: "notes.txt" } }] },
    ]);
    expect(server.chats[0]?.["tools"]).toBeUndefined();
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(server.chats).toHaveLength(1);
  });

  it("offers the two tools, runs a requested read, and feeds the result back", async () => {
    const events = await run(make({ tools: "read-only" }), [
      { toolCalls: [{ name: "read_file", arguments: { path: "notes.txt" } }] },
      { text: "The notes say: project notes" },
    ]);
    expect(
      (server.chats[0]?.["tools"] as { function: { name: string } }[]).map((t) => t.function.name),
    ).toEqual(["list_dir", "read_file"]);
    expect(validateEventStream(events)).toEqual([]);
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", name: "read_file", args: { path: "notes.txt" }, callId: "t-1-0" },
    ]);
    expect(events.filter((e) => e.type === "tool_result")).toEqual([
      { type: "tool_result", result: "project notes", callId: "t-1-0" },
    ]);
    // the second request carries the assistant's call and the tool's answer
    expect(msgs(1).map((m) => m["role"])).toEqual(["user", "assistant", "tool"]);
    expect(msgs(1)[2]).toEqual({ role: "tool", tool_name: "read_file", content: "project notes" });
    expect(events.at(-1)).toEqual({ type: "completed" });
  });

  it("refuses a tool that is not on the whitelist and tells the model", async () => {
    const events = await run(make({ tools: "read-only" }), [
      { toolCalls: [{ name: "write_file", arguments: { path: "pwned.txt", content: "x" } }] },
      { text: "ok, I cannot write" },
    ]);
    expect(readdirSync(dir).sort()).toEqual([".env", "notes.txt"]); // nothing was created
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      result: { error: expect.stringMatching(/unknown tool/) as unknown },
    });
    expect(msgs(1)[2]?.["content"]).toMatch(/^error: unknown tool/);
    expect(events.at(-1)).toEqual({ type: "completed" });
  });

  it("does not hand over a secret file or anything outside the folder", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    const events = await run(make({ tools: "read-only" }), [
      {
        toolCalls: [
          { name: "read_file", arguments: { path: ".env" } },
          { name: "read_file", arguments: { path: "../etc/hosts" } },
        ],
      },
      { text: "done" },
    ]);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(JSON.stringify(results)).not.toContain("TOKEN=abc");
    for (const r of results)
      expect(r).toMatchObject({ result: { error: expect.any(String) as unknown } });
  });

  it("accepts arguments sent as a JSON string, and survives garbage arguments", async () => {
    const events = await run(make({ tools: "read-only" }), [
      {
        toolCalls: [
          { name: "read_file", arguments: '{"path":"notes.txt"}' },
          { name: "read_file", arguments: "not json" },
        ],
      },
      { text: "done" },
    ]);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ result: "project notes" });
    expect(results[1]).toMatchObject({ result: { error: expect.any(String) as unknown } });
  });

  it("stops with an error when the model keeps asking for tools past the round limit", async () => {
    const events = await run(make({ tools: "read-only", maxToolRounds: 3 }), [
      { toolCalls: [{ name: "list_dir", arguments: { path: "." } }] }, // repeats forever
    ]);
    expect(server.chats).toHaveLength(3);
    expect(lastError(events)).toMatch(/still asking for tools after 3 rounds/);
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(validateEventStream(events)).toEqual([]);
  });

  it("a model that answers in prose (S0 behaviour) simply completes in one round", async () => {
    const events = await run(make({ tools: "read-only" }), [{ text: "It is sunny in Paris." }]);
    expect(server.chats).toHaveLength(1);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "completed" });
  });

  it("sums token usage over all rounds", async () => {
    const events = await run(make({ tools: "read-only" }), [
      { toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
      { text: "done" },
    ]);
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      data: { promptTokens: 24, completionTokens: 6 },
    });
  });
});
