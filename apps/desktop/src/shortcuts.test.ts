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
    expect(matchShortcut(ev("1"))).toBe("agent");
    expect(matchShortcut(ev("2"))).toBe("multi");
    expect(matchShortcut(ev("h"))).toBe("history");
    expect(matchShortcut(ev("H"))).toBe("history");
    expect(matchShortcut(ev(","))).toBe("settings");
    expect(matchShortcut(ev("N", { shiftKey: true }))).toBe("new");
  });
  it("needs Ctrl or Meta and ignores other keys", () => {
    expect(matchShortcut(ev("1", { ctrlKey: false }))).toBeNull();
    expect(matchShortcut(ev("1", { ctrlKey: false, metaKey: true }))).toBe("agent");
    expect(matchShortcut(ev("x"))).toBeNull();
    expect(matchShortcut(ev("1", { shiftKey: true }))).toBeNull();
  });
  it("ignores handled, composing and Alt events", () => {
    expect(matchShortcut(ev("1", { defaultPrevented: true }))).toBeNull();
    expect(matchShortcut(ev("1", { isComposing: true }))).toBeNull();
    expect(matchShortcut(ev("1", { altKey: true }))).toBeNull();
  });
});
