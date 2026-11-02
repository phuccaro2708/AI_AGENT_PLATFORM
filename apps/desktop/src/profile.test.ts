import { describe, expect, it } from "vitest";
import { DEFAULT_NICKNAME, initials, normalizeNickname } from "./profile";

describe("normalizeNickname", () => {
  it("defaults to Admin when empty or not a string", () => {
    expect(normalizeNickname("")).toBe(DEFAULT_NICKNAME);
    expect(normalizeNickname("   ")).toBe(DEFAULT_NICKNAME);
    expect(normalizeNickname(null)).toBe(DEFAULT_NICKNAME);
  });
  it("trims and bounds the length", () => {
    expect(normalizeNickname("  Phuc  ")).toBe("Phuc");
    expect(normalizeNickname("x".repeat(80))).toHaveLength(32);
  });
});

describe("initials", () => {
  it("uses one or two letters", () => {
    expect(initials("Admin")).toBe("A");
    expect(initials("huu phuc")).toBe("HP");
    expect(initials("")).toBe("?");
  });
});
