import { describe, expect, it } from "vitest";
import { autoExcludes, parseAllowAgy } from "./autoRoute";

describe("autoRoute", () => {
  it("defaults to allowing agy and only an explicit false turns it off", () => {
    expect(parseAllowAgy(null)).toBe(true);
    expect(parseAllowAgy("true")).toBe(true);
    expect(parseAllowAgy("junk")).toBe(true);
    expect(parseAllowAgy("false")).toBe(false);
  });
  it("excludes agy from automatic choice only when not allowed", () => {
    expect(autoExcludes(true)).toEqual([]);
    expect(autoExcludes(false)).toEqual(["agy"]);
  });
});
