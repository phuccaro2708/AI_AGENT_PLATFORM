import { describe, expect, it } from "vitest";
import { matchShortcut } from "./shortcuts";

const ev = (key: string, o: Partial<Parameters<typeof matchShortcut>[0]> = {}) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  isComposing: false,
  ...o,
});

describe("matchShortcut", () => {
  it("maps the basic shortcuts", () => {
    expect(matchShortcut(ev("h"))).toBe("history");
    expect(matchShortcut(ev("H"))).toBe("history");
    expect(matchShortcut(ev(","))).toBe("settings");
    expect(matchShortcut(ev("N", { shiftKey: true }))).toBe("new");
  });
  it("needs Ctrl or Meta and ignores other keys", () => {
    expect(matchShortcut(ev("h", { ctrlKey: false }))).toBeNull();
    expect(matchShortcut(ev("h", { ctrlKey: false, metaKey: true }))).toBe("history");
    expect(matchShortcut(ev("x"))).toBeNull();
    expect(matchShortcut(ev("h", { shiftKey: true }))).toBeNull();
  });
  it("no longer has mode shortcuts (one composer, reviewer optional)", () => {
    expect(matchShortcut(ev("1"))).toBeNull();
    expect(matchShortcut(ev("2"))).toBeNull();
  });
  it("ignores handled, composing and Alt events", () => {
    expect(matchShortcut(ev("h", { defaultPrevented: true }))).toBeNull();
    expect(matchShortcut(ev("h", { isComposing: true }))).toBeNull();
    expect(matchShortcut(ev("h", { altKey: true }))).toBeNull();
  });
});
