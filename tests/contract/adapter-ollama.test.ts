import { afterAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import { validateEventStream, type AgentTask } from "@agent-studio/agent-core";
import { OllamaAdapter, assertLoopbackUrl } from "@agent-studio/adapter-ollama";
import { describeAdapterContract } from "./adapter-contract.js";
import { startFakeOllama, type FakeMode, type FakeOllama } from "./fake-ollama.js";

const servers: FakeOllama[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});
const fake = async (mode: FakeMode = "ok") => {
  const s = await startFakeOllama(mode);
  servers.push(s);
  return s;
};
const make = (s: FakeOllama, extra: Record<string, unknown> = {}) =>
  new OllamaAdapter({ baseUrl: s.url, model: "m", idleTimeoutMs: 400, ...extra });
const task = (prompt = "hi", signal = new AbortController().signal, id = "t1"): AgentTask => ({
  id,
  prompt,
  cwd: process.cwd(),
  signal,
});
async function run(a: OllamaAdapter, t: AgentTask, onEach?: (e: AgentEvent, i: number) => void) {
  const out: AgentEvent[] = [];
  for await (const e of a.execute(t)) {
    onEach?.(e, out.length);
    out.push(e);
  }
  return out;
}
const lastMessage = (events: AgentEvent[]) => {
  const last = events.at(-1);
  return last?.type === "error" ? last.message : undefined;
};

const contractServer = await startFakeOllama("ok");
servers.push(contractServer);
describeAdapterContract("ollama (fake HTTP server)", {
  make: () => make(contractServer),
});

describe("OllamaAdapter", () => {
  it("streams the text chunks, then usage, then completed", async () => {
    const events = await run(make(await fake()), task());
    expect(validateEventStream(events)).toEqual([]);
    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", content: "Hel" },
      { type: "text", content: "lo " },
      { type: "text", content: "world" },
    ]);
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      data: { promptTokens: 12, completionTokens: 3 },
    });
    expect(events.at(-1)).toEqual({ type: "completed" });
  });

  it("reassembles a JSON line that arrives in two pieces", async () => {
    const events = await run(make(await fake("multi-chunk-split")), task());
    expect(events[0]).toEqual({ type: "text", content: "split-ok" });
    expect(events.at(-1)).toEqual({ type: "completed" });
  });

  it("sends the prompt as plain JSON data with the configured model, no thinking, and options", async () => {
    const s = await fake();
    const nasty = '--flag "$HOME" & echo pwned\nline2';
    await run(make(s, { numPredict: 7, keepAlive: 0 }), task(nasty));
    expect(s.chats[0]).toEqual({
      model: "m",
      stream: true,
      think: false,
      messages: [{ role: "user", content: nasty }],
      keep_alive: 0,
      options: { num_predict: 7 },
    });
  });

  it("an empty reply is an error, not a success", async () => {
    expect(lastMessage(await run(make(await fake("empty")), task()))).toMatch(/empty reply/);
  });

  it("a reply cut at the token limit is an error", async () => {
    const events = await run(make(await fake("length")), task());
    expect(lastMessage(events)).toMatch(/token limit/);
    expect(events.some((e) => e.type === "completed")).toBe(false);
  });

  it("a stream that ends without `done` is an error", async () => {
    expect(lastMessage(await run(make(await fake("no-done")), task()))).toMatch(/without a final/);
  });

  it("an output that is not JSON is an error", async () => {
    expect(lastMessage(await run(make(await fake("garbage")), task()))).toMatch(/not JSON/);
  });

  it("an `error` line from Ollama is reported after the text that came before it", async () => {
    const events = await run(make(await fake("error-line")), task());
    expect(events[0]).toEqual({ type: "text", content: "start" });
    expect(lastMessage(events)).toMatch(/llama runner process has terminated/);
    expect(validateEventStream(events)).toEqual([]);
  });

  it("HTTP errors carry the status and Ollama's message", async () => {
    expect(lastMessage(await run(make(await fake("http-500")), task()))).toMatch(
      /HTTP 500: internal boom/,
    );
    expect(lastMessage(await run(make(await fake("model-missing")), task()))).toMatch(
      /HTTP 404: model 'nope' not found/,
    );
  });

  it("fails without starting a request when no model is configured", async () => {
    const s = await fake();
    const events = await run(new OllamaAdapter({ baseUrl: s.url }), task());
    expect(lastMessage(events)).toMatch(/no Ollama model/);
    expect(s.chats).toHaveLength(0);
  });

  it("gives up when Ollama goes silent (idle timeout)", async () => {
    const events = await run(make(await fake("hang"), { idleTimeoutMs: 150 }), task());
    expect(events[0]).toEqual({ type: "text", content: "first" });
    expect(lastMessage(events)).toMatch(/sent nothing for 0\.15 s/);
  });

  it("kills a hanging run on abort and reports cancelled", async () => {
    const ac = new AbortController();
    const events = await run(
      make(await fake("hang"), { idleTimeoutMs: 5000 }),
      task("x", ac.signal),
      (e) => {
        if (e.type === "text") ac.abort();
      },
    );
    expect(events.at(-1)).toEqual({ type: "error", message: "cancelled" });
  });

  it("cancel(taskId) stops a running task", async () => {
    const a = make(await fake("hang"), { idleTimeoutMs: 5000 });
    const events = await run(a, task(), (e) => {
      if (e.type === "text") void a.cancel("t1");
    });
    expect(events.at(-1)).toEqual({ type: "error", message: "cancelled" });
  });

  it("detect() is true for a live server and false when nothing listens", async () => {
    const s = await fake();
    expect(await make(s).detect()).toBe(true);
    // a live server is not enough: without a configured model nothing could run
    expect(await new OllamaAdapter({ baseUrl: s.url }).detect()).toBe(false);
    const dead = new OllamaAdapter({ baseUrl: "http://127.0.0.1:1", model: "m" });
    expect(await dead.detect()).toBe(false);
    const events = await run(dead, task());
    expect(events).toHaveLength(1);
    expect(lastMessage(events)).toMatch(/not reachable at http:\/\/127\.0\.0\.1:1/);
  });

  it("capabilities are limited to what was observed", async () => {
    expect(await make(await fake()).capabilities()).toEqual(["streaming"]);
  });

  it("refuses a server that is not on a loopback address", () => {
    expect(() => new OllamaAdapter({ baseUrl: "http://192.168.1.5:11434" })).toThrow(/loopback/);
    expect(() => new OllamaAdapter({ baseUrl: "https://example.com" })).toThrow(/loopback/);
    expect(() => new OllamaAdapter({ baseUrl: "file:///etc/passwd" })).toThrow(/loopback/);
    expect(() => new OllamaAdapter({ baseUrl: "not a url" })).toThrow(/invalid/);
    expect(assertLoopbackUrl("http://localhost:11434/")).toBe("http://localhost:11434");
    expect(assertLoopbackUrl("http://[::1]:11434")).toBe("http://[::1]:11434");
  });
});
