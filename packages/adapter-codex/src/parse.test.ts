import { describe, expect, it } from "vitest";
import { codexSandboxFor } from "./adapter.js";
import { createCodexParser } from "./parse.js";

describe("createCodexParser callId", () => {
  it("uses the item id on both the call and its result", () => {
    const p = createCodexParser();
    const item = { id: "item_1", type: "command_execution", command: "ls", status: "in_progress" };
    const started = p.parse(JSON.stringify({ type: "item.started", item }));
    expect(started.events).toEqual([
      expect.objectContaining({ type: "tool_call", callId: "item_1" }),
    ]);
    const done = p.parse(
      JSON.stringify({
        type: "item.completed",
        item: { ...item, status: "completed", exit_code: 0, aggregated_output: "" },
      }),
    );
    expect(done.events).toEqual([
      expect.objectContaining({ type: "tool_result", callId: "item_1" }),
    ]);
  });
});

describe("codexSandboxFor", () => {
  it("maps task permissions to -s values, falling back to the adapter option then read-only", () => {
    expect(codexSandboxFor("workspace-write", undefined)).toBe("workspace-write");
    expect(codexSandboxFor("read-only", "workspace-write")).toBe("read-only");
    expect(codexSandboxFor(undefined, "workspace-write")).toBe("workspace-write");
    expect(codexSandboxFor(undefined, undefined)).toBe("read-only");
  });
});
