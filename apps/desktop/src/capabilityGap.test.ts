import { describe, expect, it } from "vitest";
import { AgentCapability } from "@agent-studio/contracts";
import { describeCapabilityGap as orchestratorDescribe } from "../../../services/orchestrator/src/capability-router";
import type { AdapterInfo } from "./api";
import {
  AGENT_TASK_REQUIRES,
  PEER_REVIEW_REQUIRES,
  capabilityBlocker,
  describeGap,
  gapOf,
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
