import { describe, expect, it } from "vitest";
import { StubAdapter, validateCapabilities, validateEventStream } from "@agent-studio/agent-core";
import { describeAdapterContract } from "./adapter-contract.js";

describeAdapterContract("stub", { make: () => new StubAdapter() });

describe("contract validators catch violations", () => {
  const done = { type: "completed" } as const;
  it("accepts a conforming stream", () => {
    expect(validateEventStream([{ type: "text", content: "x" }, done])).toEqual([]);
    expect(validateEventStream([{ type: "error", message: "boom" }])).toEqual([]);
  });
  it("flags an empty stream and a missing terminal event", () => {
    expect(validateEventStream([])).toHaveLength(1);
    expect(validateEventStream([{ type: "text", content: "x" }])).toHaveLength(1);
  });
  it("flags events after the terminal event", () => {
    const p = validateEventStream([done, { type: "text", content: "late" }]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/after the terminal/);
  });
  it("flags two terminal events and invalid events", () => {
    expect(validateEventStream([done, { type: "error", message: "x" }])).toHaveLength(1);
    expect(validateEventStream([{ type: "nope" }, done]).join()).toMatch(/not a valid AgentEvent/);
    expect(validateEventStream([{ type: "text" }, done]).join()).toMatch(/not a valid AgentEvent/);
  });
  it("flags bad capabilities", () => {
    expect(validateCapabilities(["streaming"])).toEqual([]);
    expect(validateCapabilities("streaming")).toHaveLength(1);
    expect(validateCapabilities(["streaming", "streaming"])).toHaveLength(1);
    expect(validateCapabilities(["teleport"])).toHaveLength(1);
  });
});
