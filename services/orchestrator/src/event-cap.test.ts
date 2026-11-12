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

  it("keeps numbers, booleans and null, and the shape of the event", () => {
    const out = capEventStrings({ a: 1, b: true, c: null, d: "z".repeat(500) }, 100);
    expect(out).toMatchObject({ a: 1, b: true, c: null });
    expect(Object.keys(out)).toEqual(["a", "b", "c", "d"]);
    expect(chars(out)).toBeLessThan(200);
  });
});
