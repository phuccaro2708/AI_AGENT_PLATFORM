import { describe, expect, it } from "vitest";
import { AdapterRegistry, StubAdapter, type AgentAdapter } from "@agent-studio/agent-core";
import type { AgentCapability } from "@agent-studio/contracts";
import {
  describeCapabilityGap,
  selectAgent,
  snapshotAdapters,
  type AgentSnapshot,
} from "./capability-router.js";

const snap = (id: string, caps: AgentCapability[], available = true): AgentSnapshot => ({
  id,
  available,
  capabilities: caps,
});
const agents = [
  snap("claude", ["streaming", "structured_output", "tool_execution", "session_resume"]),
  snap("codex", ["streaming", "structured_output", "tool_execution"]),
  snap("agy", ["streaming", "structured_output"]),
];

describe("selectAgent", () => {
  it("picks the first agent with every required capability", () => {
    expect(selectAgent(agents, ["streaming"])).toEqual({ ok: true, agentId: "claude" });
    expect(selectAgent(agents, ["session_resume"])).toEqual({ ok: true, agentId: "claude" });
  });
  it("honours prefer when the preferred agent qualifies, and falls back when it does not", () => {
    expect(selectAgent(agents, ["streaming"], { prefer: ["agy"] })).toEqual({
      ok: true,
      agentId: "agy",
    });
    expect(selectAgent(agents, ["tool_execution"], { prefer: ["agy", "codex"] })).toEqual({
      ok: true,
      agentId: "codex",
    });
  });
  it("skips unavailable agents and excluded ids", () => {
    const list = [snap("claude", ["streaming"], false), snap("agy", ["streaming"])];
    expect(selectAgent(list, ["streaming"])).toEqual({ ok: true, agentId: "agy" });
    expect(selectAgent(list, ["streaming"], { exclude: ["agy"] })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });
  it("reports what each agent lacks instead of pretending", () => {
    const r = selectAgent(agents, ["approval"]);
    expect(r).toMatchObject({ ok: false, reason: "missing_capabilities" });
    if (!r.ok) {
      expect(r.gaps.map((g) => [g.agentId, g.missing])).toEqual([
        ["claude", ["approval"]],
        ["codex", ["approval"]],
        ["agy", ["approval"]],
      ]);
    }
  });
  it("no agents at all", () => {
    expect(selectAgent([], ["streaming"])).toEqual({ ok: false, reason: "no_agents", gaps: [] });
  });
});

describe("describeCapabilityGap", () => {
  it("names the missing capabilities in Vietnamese", () => {
    expect(
      describeCapabilityGap({ agentId: "agy", available: true, missing: ["session_resume"] }),
    ).toBe("agy không hỗ trợ: tiếp tục phiên (resume)");
    expect(describeCapabilityGap({ agentId: "agy", available: false, missing: [] })).toBe(
      "agy chưa cài hoặc không tìm thấy CLI",
    );
    expect(describeCapabilityGap({ agentId: "x", available: true, missing: [] })).toBe("");
  });
});

describe("a new adapter joins routing without touching core code", () => {
  it("is picked purely from its declared capabilities", async () => {
    const registry = new AdapterRegistry();
    registry.register(new StubAdapter());
    const fresh: AgentAdapter = {
      id: "brand-new",
      detect: async () => true,
      capabilities: async () => ["streaming", "approval"],
      execute: async function* () {
        yield { type: "completed" };
      },
      cancel: async () => undefined,
    };
    registry.register(fresh);
    const r = selectAgent(await snapshotAdapters(registry), ["approval"], { exclude: ["stub"] });
    expect(r).toEqual({ ok: true, agentId: "brand-new" });
  });
});
