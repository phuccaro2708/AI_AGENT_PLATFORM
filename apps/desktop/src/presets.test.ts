import { describe, expect, it } from "vitest";
import {
  BUILTIN_ASSISTANT,
  composePrompt,
  normalizePreset,
  parsePresets,
  serializePresets,
  type Preset,
} from "./presets";

const ok: Preset = { id: "a1", name: "Reviewer", agentId: "claude", instructions: "Review it." };

describe("normalizePreset", () => {
  it("trims and keeps a valid preset", () => {
    expect(normalizePreset({ id: " a1 ", name: " N ", instructions: " do " })).toEqual({
      id: "a1",
      name: "N",
      instructions: "do",
    });
  });
  it("rejects missing or blank fields and non-objects", () => {
    expect(normalizePreset(null)).toBeNull();
    expect(normalizePreset("x")).toBeNull();
    expect(normalizePreset({ id: "a", name: " ", instructions: "x" })).toBeNull();
    expect(normalizePreset({ id: "a", name: "n" })).toBeNull();
  });
  it("bounds long instructions", () => {
    const p = normalizePreset({ id: "a", name: "n", instructions: "x".repeat(9000) });
    expect(p?.instructions.length).toBe(4000);
  });
});

describe("parsePresets", () => {
  it("round-trips export to import", () => {
    const r = parsePresets(serializePresets([ok]));
    expect(r).toEqual({ ok: true, presets: [ok] });
  });
  it("reports bad JSON, wrong shape, bad items", () => {
    expect(parsePresets("{").ok).toBe(false);
    expect(parsePresets("{}").ok).toBe(false);
    expect(parsePresets('[{"id":"a"}]').ok).toBe(false);
  });
  it("rejects duplicate ids and the built-in id", () => {
    expect(parsePresets(serializePresets([ok, ok])).ok).toBe(false);
    expect(parsePresets(serializePresets([{ ...ok, id: BUILTIN_ASSISTANT.id }])).ok).toBe(false);
  });
  it("rejects too many presets and oversized text", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...ok, id: `p${i}` }));
    expect(parsePresets(JSON.stringify(many)).ok).toBe(false);
    expect(parsePresets(" ".repeat(400_001)).ok).toBe(false);
  });
});

describe("composePrompt", () => {
  it("puts instructions before the user text", () => {
    expect(composePrompt(ok, "Fix it")).toBe("Review it.\n\nFix it");
  });
  it("leaves the text alone without a preset", () => {
    expect(composePrompt(undefined, "Fix it")).toBe("Fix it");
  });
});
