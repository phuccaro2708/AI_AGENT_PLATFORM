import { describe, expect, it } from "vitest";
import { AgentEvent } from "@agent-studio/contracts";
import { AdapterRegistry, StubAdapter, type AgentTask } from "./index.js";

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: "t1",
  prompt: "hello",
  cwd: "/work",
  signal: new AbortController().signal,
  ...over,
});

async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("StubAdapter", () => {
  it("emits deterministic events that all validate against the contracts", async () => {
    const a = await collect(new StubAdapter().execute(task()));
    const b = await collect(new StubAdapter().execute(task()));
    expect(a).toEqual(b);
    for (const e of a) expect(AgentEvent.safeParse(e).success).toBe(true);
    expect(a.at(-1)).toEqual({ type: "completed", sessionId: "stub-session-t1" });
  });

  it("stops with an error event when the AbortSignal fires", async () => {
    const ac = new AbortController();
    const events: AgentEvent[] = [];
    for await (const e of new StubAdapter().execute(task({ signal: ac.signal }))) {
      events.push(e);
      if (events.length === 1) ac.abort();
    }
    expect(events.at(-1)).toEqual({ type: "error", message: "cancelled" });
  });

  it("stops after cancel(taskId)", async () => {
    const stub = new StubAdapter();
    await stub.cancel("t1");
    const events = await collect(stub.execute(task()));
    expect(events).toEqual([{ type: "error", message: "cancelled" }]);
  });
});

describe("AdapterRegistry", () => {
  it("registers, lists, rejects duplicates and detects availability", async () => {
    const r = new AdapterRegistry();
    r.register(new StubAdapter("a"));
    expect(() => r.register(new StubAdapter("a"))).toThrow();
    r.register({ ...new StubAdapter("b"), id: "b", detect: async () => false, capabilities: async () => [], cancel: async () => {}, execute: () => (async function* () {})() });
    expect(r.list()).toHaveLength(2);
    expect((await r.detectAvailable()).map((x) => x.id)).toEqual(["a"]);
  });
});
