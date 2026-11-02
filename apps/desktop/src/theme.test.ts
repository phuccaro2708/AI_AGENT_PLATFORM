import { describe, expect, it } from "vitest";
import { isTheme, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("a saved choice beats the system preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("follows the system when nothing valid is saved", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("purple", true)).toBe("dark");
    expect(resolveTheme(42, false)).toBe("light");
  });
  it("isTheme only accepts the two modes", () => {
    expect([isTheme("light"), isTheme("dark"), isTheme("auto"), isTheme(undefined)]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});
