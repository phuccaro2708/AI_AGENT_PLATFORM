import type { AgentCapability } from "@agent-studio/contracts";
import type { AdapterInfo } from "./api";

/**
 * What an agent lacks for a given job. Same shape as `CapabilityGap` in the orchestrator's
 * `capability-router.ts`; the UI computes it from `agents.list` (id, available, capabilities),
 * which is exactly the snapshot the router uses, so no extra IPC method is needed.
 */
export interface CapabilityGap {
  agentId: string;
  available: boolean;
  missing: AgentCapability[];
}

/**
 * What each screen needs from the agent it lets you pick. UI-level requirement, not a backend rule:
 * - single agent: the task log is rendered live, so `streaming`;
 * - Peer Review: both roles work in a worktree with `permissions` set (workspace-write / read-only)
 *   and run tools, so `tool_execution`.
 */
export const AGENT_TASK_REQUIRES: readonly AgentCapability[] = ["streaming"];
export const PEER_REVIEW_REQUIRES: readonly AgentCapability[] = ["tool_execution"];

/** Vietnamese labels. Kept identical to the orchestrator's (a test fails if they drift). */
const LABELS: Record<AgentCapability, string> = {
  streaming: "phát kết quả theo luồng",
  session_resume: "tiếp tục phiên (resume)",
  tool_execution: "chạy công cụ",
  structured_output: "đầu ra có cấu trúc",
  approval: "luồng phê duyệt",
  interactive_terminal: "terminal tương tác",
  model_selection: "chọn model",
};

export function gapOf(agent: AdapterInfo, required: readonly AgentCapability[]): CapabilityGap {
  // `required` only holds contract names, so unknown names an adapter reports can never match.
  const have = new Set<string>(agent.capabilities);
  return {
    agentId: agent.id,
    available: agent.available,
    missing: required.filter((c) => !have.has(c)),
  };
}

export function describeGap(gap: CapabilityGap): string {
  const parts: string[] = [];
  if (!gap.available) parts.push("chưa cài hoặc không tìm thấy CLI");
  if (gap.missing.length > 0) {
    parts.push(`không hỗ trợ: ${gap.missing.map((c) => LABELS[c]).join(", ")}`);
  }
  return parts.length === 0 ? "" : `${gap.agentId} ${parts.join("; ")}`;
}

/**
 * Why the chosen agent cannot do this job because of a missing capability; null when it can (or when
 * nothing is chosen). A missing CLI is not mentioned here: callers already report that on its own.
 */
export function capabilityBlocker(
  agent: AdapterInfo | undefined,
  required: readonly AgentCapability[],
): string | null {
  if (!agent) return null;
  const gap = gapOf(agent, required);
  return gap.missing.length === 0 ? null : describeGap({ ...gap, available: true });
}
