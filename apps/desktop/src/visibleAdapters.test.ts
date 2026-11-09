import { describe, expect, it } from "vitest";
import type { AdapterInfo } from "./api";
import { visibleAdapters } from "./visibleAdapters";

const a = (id: string): AdapterInfo => ({ id, available: true, capabilities: [] });
const all = [a("claude"), a("stub"), a("codex")];

describe("visibleAdapters", () => {
  it("hides the stub adapter outside dev mode and keeps the others in order", () => {
    expect(visibleAdapters(all, false).map((x) => x.id)).toEqual(["claude", "codex"]);
  });

  it("shows every adapter, stub included, in dev mode", () => {
    expect(visibleAdapters(all, true).map((x) => x.id)).toEqual(["claude", "stub", "codex"]);
  });

  it("does not mutate its input", () => {
    const copy = [...all];
    visibleAdapters(all, false);
    expect(all).toEqual(copy);
  });
});
