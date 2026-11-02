import { describe, expect, it } from "vitest";
import { folderName } from "./projectName";

describe("folderName", () => {
  it("takes the last segment of Windows and POSIX paths", () => {
    expect(folderName("D:\\Idea\\AI_AGENT_PLATFORM")).toBe("AI_AGENT_PLATFORM");
    expect(folderName("/home/me/my-app")).toBe("my-app");
  });
  it("ignores trailing separators and surrounding spaces", () => {
    expect(folderName("  C:\\work\\demo\\ ")).toBe("demo");
    expect(folderName("/a/b//")).toBe("b");
  });
  it("returns an empty name for empty input or a bare drive", () => {
    expect(folderName("")).toBe("");
    expect(folderName("C:\\")).toBe("");
    expect(folderName("C:")).toBe("");
  });
});
