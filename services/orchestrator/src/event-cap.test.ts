import { describe, expect, it } from "vitest";
import { capEventStrings } from "./event-cap.js";

const chars = (v: unknown): number => JSON.stringify(v).length;

describe("capEventStrings", () => {
  it("returns an event under the limit unchanged (same object)", () => {
    const ev = { type: "text", content: "hello", nested: [{ a: "b" }], n: 3 };
    expect(capEventStrings(ev, 100)).toBe(ev);
  });

  it("cuts one long string to the limit and says how much was cut", () => {
    const out = capEventStrings({ type: "t", content: "x".repeat(5000) }, 1000);
    expect(out.type).toBe("t");
    expect(out.content.length).toBeLessThanOrEqual(999);
    expect(out.content).toMatch(/characters cut/);
    expect(out.content.startsWith("xxx")).toBe(true);
  });

  it("budgets all strings together, so many medium strings cannot add up past the limit", () => {
    const ev = { parts: Array.from({ length: 10 }, () => "y".repeat(900)) };
    const out = capEventStrings(ev, 2000);
    const total = out.parts.reduce((n, s) => n + s.length, 0);
    expect(total).toBeLessThanOrEqual(2000);
    expect(out.parts[0]).toBe("y".repeat(900));
    expect(out.parts.at(-1)).toBe("");
  });

  it("keeps short identifiers whole even when a long field comes first", () => {
    const ev = {
      type: "tool_call",
      name: "Write",
      args: { content: "x".repeat(1_100_000) },
      callId: "c".repeat(32),
    };
    const out = capEventStrings(ev);
    expect(out.callId).toBe("c".repeat(32));
    expect(out.name).toBe("Write");
    expect(out.args.content).toMatch(/characters cut/);
    expect(chars(out)).toBeLessThanOrEqual(1_048_576 + 200);
  });

  it("counts and cuts object keys, so a huge key cannot slip past the limit", () => {
    const out = capEventStrings({ type: "tool_call", args: { ["K".repeat(3_000_000)]: 0 } }, 1000);
    const keys = Object.keys(out.args);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.length).toBeLessThanOrEqual(1000);
    expect(chars(out)).toBeLessThan(1100);
  });

  it("keeps the event's own fields when a nested part is made of many short strings", () => {
    const ev = {
      type: "tool_call",
      name: "Write",
      args: {
        parts: [...Array<string>(11_000).fill("x".repeat(100)), ...Array<string>(100).fill("x")],
      },
      callId: "call-123",
    };
    const out = capEventStrings(ev);
    expect(Object.keys(out)).toEqual(["type", "name", "args", "callId"]);
    expect(out).toMatchObject({ type: "tool_call", name: "Write", callId: "call-123" });
    expect(Object.keys(out.args)).toEqual(["parts"]);
    expect(out.args.parts.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(1_048_576);
  });

  it("keeps a top-level callId longer than a short field when the nested part is huge", () => {
    const ev = {
      type: "tool_call",
      name: "Write",
      args: { parts: Array<string>(11_000).fill("x".repeat(100)) },
      callId: "c".repeat(257),
    };
    const out = capEventStrings(ev);
    expect(out.callId).toBe("c".repeat(257));
  });

  it("still holds the bound when the payload is made of many short strings", () => {
    const ev = { parts: Array.from({ length: 50 }, () => "s".repeat(100)) };
    const out = capEventStrings(ev, 1000);
    expect(out.parts.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(1000);
  });

  it("never exceeds the limit (keys and values together) over many random shapes", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const str = () => "q".repeat([1, 10, 200, 300, 5000][rnd(5)]!);
    const gen = (d: number): unknown => {
      const r = rnd(4);
      if (d > 3 || r === 0) return str();
      if (r === 1) return Array.from({ length: rnd(30) }, () => gen(d + 1));
      return Object.fromEntries(Array.from({ length: rnd(30) }, (_, i) => [str() + i, gen(d + 1)]));
    };
    const strings = (v: unknown): number =>
      typeof v === "string"
        ? v.length
        : Array.isArray(v)
          ? v.reduce<number>((n, x) => n + strings(x), 0)
          : v && typeof v === "object"
            ? Object.entries(v).reduce<number>((n, [k, x]) => n + k.length + strings(x), 0)
            : 0;
    for (let i = 0; i < 200; i++) {
      const max = 500 + rnd(20_000);
      expect(strings(capEventStrings({ type: "t", body: gen(0) }, max))).toBeLessThanOrEqual(max);
    }
  });

  it("keeps numbers, booleans and null, and the shape of the event", () => {
    const out = capEventStrings({ a: 1, b: true, c: null, d: "z".repeat(500) }, 100);
    expect(out).toMatchObject({ a: 1, b: true, c: null });
    expect(Object.keys(out)).toEqual(["a", "b", "c", "d"]);
    expect(chars(out)).toBeLessThan(200);
  });
});
