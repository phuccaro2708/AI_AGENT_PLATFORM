import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import { validateEventStream, type AgentTask } from "@agent-studio/agent-core";
import { describeAdapterContract } from "./adapter-contract.js";
import { AntigravityAdapter, createAntigravityParser } from "@agent-studio/adapter-antigravity";

const fake = fileURLToPath(
  new URL("../../packages/adapter-antigravity/test/fake-agy.mjs", import.meta.url),
);
const fixtureDir = new URL("../contracts/fixtures/agy/1.4.8/", import.meta.url);
const lines = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, fixtureDir)), "utf8")
    .trim()
    .split("\n");

const make = (mode = "ok", extra: Record<string, unknown> = {}) =>
  new AntigravityAdapter({
    command: process.execPath,
    baseArgs: [fake],
    env: { ...process.env, FAKE_MODE: mode },
    envAllow: ["FAKE_MODE"],
    ...extra,
  });
const task = (prompt = "hi", signal = new AbortController().signal, id = "t1"): AgentTask => ({
  id,
  prompt,
  cwd: process.cwd(),
  signal,
});
async function run(
  a: AntigravityAdapter,
  t: AgentTask,
  onEach?: (e: AgentEvent, i: number) => void,
) {
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

describeAdapterContract("agy (fake CLI)", { make: () => make() });

describe("createAntigravityParser on the REAL agy 1.4.8 fixtures", () => {
  it("print-ok: text deltas, usage from result only, completed", () => {
    const p = createAntigravityParser();
    const parsed = lines("print-ok.stream-json.ndjson").map((l) => p.parse(l));
    const events = parsed.flatMap((x) => x.events);
    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", content: "ok" },
      { type: "text", content: "\n" },
    ]);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    expect(parsed.at(-1)?.final).toEqual({ type: "completed" });
  });

  it("print-plan-timeout: SUCCESS + empty response + 0 turns is an error, not a success", () => {
    const p = createAntigravityParser();
    const parsed = lines("print-plan-timeout.stream-json.ndjson").map((l) => p.parse(l));
    const final = parsed.at(-1)?.final;
    expect(final?.type).toBe("error");
    expect(final?.type === "error" && final.message).toMatch(/num_turns=0/);
  });

  it("an empty response with turns > 0 is also an error", () => {
    const p = createAntigravityParser();
    const r = p.parse(
      '{"event":"result","result":{"status":"SUCCESS","response":" \\n","num_turns":1}}',
    );
    expect(r.final).toMatchObject({ type: "error" });
  });

  it("a non-SUCCESS status is an error", () => {
    const p = createAntigravityParser();
    const r = p.parse(
      '{"event":"result","result":{"status":"FAILED","response":"x","num_turns":1}}',
    );
    expect(r.final).toEqual({ type: "error", message: "agy reported status FAILED" });
  });

  it("ignores junk, unknown events and non-text steps", () => {
    const p = createAntigravityParser();
    for (const l of [
      "",
      "not json",
      "[]",
      "42",
      '{"event":"init","init":{}}',
      '{"event":"mystery"}',
      '{"event":"step_update","step_update":{"step_type":"user_input","state":"DONE"}}',
      '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":""}}',
    ]) {
      expect(p.parse(l)).toEqual({ events: [] });
    }
  });
});

describe("AntigravityAdapter", () => {
  it("streams text then completed, and drops anything after the end", async () => {
    const events = await run(make(), task());
    expect(validateEventStream(events)).toEqual([]);
    expect(events[0]).toEqual({ type: "text", content: "ok" });
    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(JSON.stringify(events)).not.toContain("late");
  });
  it("passes the prompt as a single argv element, untouched (no shell)", async () => {
    const nasty = '--flag "$HOME" & echo pwned\nline2';
    const events = await run(make("echo"), task(nasty));
    expect(events[0]).toEqual({ type: "text", content: nasty });
  });
  it("uses exactly the probed argv and never --mode plan / sandbox / skip-permissions", async () => {
    const events = await run(make("args"), { ...task("hello"), sessionId: "abc" });
    const argv = JSON.parse((events[0] as { content: string }).content) as string[];
    expect(argv).toEqual(["--print", "hello", "--output-format", "stream-json"]);
  });
  it("exit 0 with an empty plan-style result is an error (the --mode plan trap)", async () => {
    const events = await run(make("plan-empty"), task());
    expect(lastMessage(events)).toMatch(/num_turns=0/);
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(validateEventStream(events)).toEqual([]);
  });
  it("a whitespace-only response is an error", async () => {
    const events = await run(make("empty-response"), task());
    expect(lastMessage(events)).toMatch(/empty response/);
  });
  it("exit 0 without any result line is an error, not a success", async () => {
    const events = await run(make("no-result"), task());
    expect(lastMessage(events)).toMatch(/code 0.*without a result/s);
  });
  it("fails closed when task permissions are set (cannot be enforced)", async () => {
    const events = await run(make(), { ...task(), permissions: "read-only" });
    expect(events).toHaveLength(1);
    expect(lastMessage(events)).toMatch(/cannot enforce task permissions/);
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
    expect(lastMessage(await run(make("crash"), task()))).toMatch(
      /code 3.*without a result.*boom/s,
    );
  });
  it("malformed JSON output without a result is reported", async () => {
    expect(lastMessage(await run(make("garbage"), task()))).toMatch(
      /without a result.*2 output lines were not valid JSON/s,
    );
  });
  it("a missing CLI is an error event, detect() is false, and nothing throws", async () => {
    const a = new AntigravityAdapter({ command: "definitely-not-a-real-cli-xyz" });
    expect(await a.detect()).toBe(false);
    const events = await run(a, task());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
  });
  it("capabilities are limited to what was observed", async () => {
    expect(await make().detect()).toBe(true);
    expect(await make().capabilities()).toEqual(["streaming", "structured_output"]);
  });
});
