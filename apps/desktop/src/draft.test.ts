import { describe, expect, it } from "vitest";
import { draftAfterStart } from "./draft";

describe("draftAfterStart", () => {
  it("clears the draft once the task was accepted", () => {
    expect(draftAfterStart("  long text ", "long text", true)).toBe("");
    expect(draftAfterStart("long text", "long text", undefined)).toBe("");
  });
  it("keeps the draft when the backend refused (API reject / validation error)", () => {
    expect(draftAfterStart("long text", "long text", false)).toBe("long text");
  });
  it("keeps text the user typed while the request was running", () => {
    expect(draftAfterStart("long text and more", "long text", true)).toBe("long text and more");
  });
});
