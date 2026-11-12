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

  it("still holds the bound when the payload is made of many short strings", () => {
    const ev = { parts: Array.from({ length: 50 }, () => "s".repeat(100)) };
    const out = capEventStrings(ev, 1000);
    expect(out.parts.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(1000);
  });

  it("keeps numbers, booleans and null, and the shape of the event", () => {
    const out = capEventStrings({ a: 1, b: true, c: null, d: "z".repeat(500) }, 100);
    expect(out).toMatchObject({ a: 1, b: true, c: null });
    expect(Object.keys(out)).toEqual(["a", "b", "c", "d"]);
    expect(chars(out)).toBeLessThan(200);
  });
});
