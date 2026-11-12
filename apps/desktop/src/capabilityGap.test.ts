import { describe, expect, it } from "vitest";
import { AgentCapability } from "@agent-studio/contracts";
import { describeCapabilityGap as orchestratorDescribe } from "../../../services/orchestrator/src/capability-router";
import type { AdapterInfo } from "./api";
import {
  AGENT_TASK_REQUIRES,
  AUTO_AGENT,
  NO_REVIEWER,
  PEER_REVIEW_REQUIRES,
  capabilityBlocker,
  describeGap,
  gapOf,
  startBlocker,
} from "./capabilityGap";

const agy: AdapterInfo = {
  id: "agy",
  available: true,
  capabilities: ["streaming", "structured_output"],
};
const claude: AdapterInfo = {
  id: "claude",
  available: true,
  capabilities: ["streaming", "structured_output", "tool_execution", "session_resume"],
};

describe("gapOf", () => {
  it("lists only the required capabilities the agent does not declare", () => {
    expect(gapOf(agy, ["streaming", "tool_execution", "approval"])).toEqual({
      agentId: "agy",
      available: true,
      missing: ["tool_execution", "approval"],
    });
  });

  it("ignores capability names the contract does not know", () => {
    const odd: AdapterInfo = { id: "x", available: true, capabilities: ["future_thing"] };
    expect(gapOf(odd, ["streaming"]).missing).toEqual(["streaming"]);
  });

  it("carries availability through", () => {
    expect(gapOf({ ...claude, available: false }, []).available).toBe(false);
  });
});

describe("describeGap", () => {
  it("is empty when nothing is missing", () => {
    expect(describeGap(gapOf(claude, PEER_REVIEW_REQUIRES))).toBe("");
  });

  it("names the missing capability in Vietnamese", () => {
    expect(describeGap(gapOf(agy, PEER_REVIEW_REQUIRES))).toBe("agy không hỗ trợ: chạy công cụ");
  });

  it("mentions a missing CLI as well", () => {
    expect(describeGap(gapOf({ ...agy, available: false }, PEER_REVIEW_REQUIRES))).toBe(
      "agy chưa cài hoặc không tìm thấy CLI; không hỗ trợ: chạy công cụ",
    );
  });

  it("matches the orchestrator's describeCapabilityGap for every capability (no drift)", () => {
    for (const cap of AgentCapability.options) {
      const gap = { agentId: "a", available: true, missing: [cap] };
      expect(describeGap(gap)).toBe(orchestratorDescribe(gap));
    }
    const both = { agentId: "a", available: false, missing: [...AgentCapability.options] };
    expect(describeGap(both)).toBe(orchestratorDescribe(both));
  });
});

describe("capabilityBlocker", () => {
  it("is null for an agent that meets the requirement", () => {
    expect(capabilityBlocker(claude, PEER_REVIEW_REQUIRES)).toBeNull();
    expect(capabilityBlocker(agy, AGENT_TASK_REQUIRES)).toBeNull();
  });

  it("explains a missing capability but not a missing CLI (callers already show that)", () => {
    expect(capabilityBlocker(agy, PEER_REVIEW_REQUIRES)).toBe("agy không hỗ trợ: chạy công cụ");
    expect(capabilityBlocker({ ...agy, available: false }, PEER_REVIEW_REQUIRES)).toBe(
      "agy không hỗ trợ: chạy công cụ",
    );
  });

  it("is null when no agent is selected", () => {
    expect(capabilityBlocker(undefined, PEER_REVIEW_REQUIRES)).toBeNull();
  });
});

describe("startBlocker (one composer, reviewer optional)", () => {
  const codex: AdapterInfo = {
    id: "codex",
    available: true,
    capabilities: ["streaming", "tool_execution"],
  };
  const gone: AdapterInfo = {
    id: "gone",
    available: false,
    capabilities: ["streaming", "tool_execution"],
  };
  const adapters = [claude, codex, agy, gone];
  const base = {
    hasProject: true,
    adapters,
    agentId: "claude",
    reviewerId: NO_REVIEWER,
    prompt: "do it",
  };

  it("asks for a project, then for text", () => {
    expect(startBlocker({ ...base, hasProject: false })).toBe("Choose a project first");
    expect(startBlocker({ ...base, prompt: "  " })).toBe("Describe the task");
    expect(startBlocker(base)).toBeNull();
  });
  it("without a reviewer: Auto is allowed and only streaming is required", () => {
    expect(startBlocker({ ...base, agentId: AUTO_AGENT })).toBeNull();
    expect(startBlocker({ ...base, agentId: "agy" })).toBeNull();
    expect(startBlocker({ ...base, agentId: "gone" })).toBe("gone was not found on this machine");
    expect(startBlocker({ ...base, agentId: "nope" })).toBe("Pick an agent");
  });
  it("with a reviewer: both roles must be concrete, installed and able to run tools", () => {
    expect(startBlocker({ ...base, reviewerId: "codex" })).toBeNull();
    expect(startBlocker({ ...base, agentId: AUTO_AGENT, reviewerId: "codex" })).toBe(
      "Pick an agent to pair with a reviewer",
    );
    expect(startBlocker({ ...base, reviewerId: "gone" })).toBe(
      "gone was not found on this machine",
    );
    expect(startBlocker({ ...base, reviewerId: "agy" })).toMatch(/^agy không hỗ trợ/);
    expect(startBlocker({ ...base, agentId: "agy", reviewerId: "codex" })).toMatch(/^agy/);
  });
});
