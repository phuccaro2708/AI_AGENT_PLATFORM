import { describe, expect, it } from "vitest";
import { claudePermissionArgs } from "./adapter.js";
import { parseClaudeLine } from "./parse.js";

describe("parseClaudeLine callId", () => {
  it("carries tool_use.id and tool_result.tool_use_id", () => {
    const call = parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
      }),
    );
    expect(call.events).toEqual([{ type: "tool_call", name: "Read", args: {}, callId: "toolu_1" }]);
    const res = parseClaudeLine(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      }),
    );
    expect(res.events).toEqual([{ type: "tool_result", result: "ok", callId: "toolu_1" }]);
  });

  it("omits callId when the CLI sends none", () => {
    const call = parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
      }),
    );
    expect(call.events[0]).not.toHaveProperty("callId");
  });
});

describe("claudePermissionArgs", () => {
  it("adds nothing when the task states no permissions", () => {
    expect(claudePermissionArgs(undefined)).toEqual([]);
  });
  it("read-only restricts the tool set to non-writing tools", () => {
    const a = claudePermissionArgs("read-only");
    expect(a[0]).toBe("--tools");
    expect(a[1]).toBe("Read,Grep,Glob");
  });
  it("workspace-write adds edit tools and accepts edits, but no shell", () => {
    const a = claudePermissionArgs("workspace-write");
    expect(a).toContain("--permission-mode");
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(a[a.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write");
  });
});
