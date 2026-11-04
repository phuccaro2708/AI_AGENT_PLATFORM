import type { AgentCapability } from "@agent-studio/contracts";
import type { AdapterRegistry } from "@agent-studio/agent-core";

/** What the router needs to know about an agent; a snapshot, so selection stays pure. */
export interface AgentSnapshot {
  id: string;
  available: boolean;
  capabilities: readonly AgentCapability[];
}

export interface CapabilityGap {
  agentId: string;
  available: boolean;
  missing: AgentCapability[];
}

export type RouteResult =
  | { ok: true; agentId: string }
  | {
      ok: false;
      reason: "no_agents" | "unavailable" | "missing_capabilities";
      gaps: CapabilityGap[];
    };

export interface RouteOptions {
  /** Agent ids tried first, in order, when they qualify. Otherwise registration order decides. */
  prefer?: readonly string[];
  /** Ids never picked (e.g. the test stub). */
  exclude?: readonly string[];
}

const missingFrom = (a: AgentSnapshot, required: readonly AgentCapability[]) =>
  required.filter((c) => !a.capabilities.includes(c));

/**
 * Picks the first available agent that has every required capability. Agents are never matched by
 * name: a newly registered adapter participates as soon as it declares capabilities. When nothing
 * qualifies, `gaps` says what each agent lacks so the caller can tell the user instead of faking it.
 */
export function selectAgent(
  agents: readonly AgentSnapshot[],
  required: readonly AgentCapability[],
  opts: RouteOptions = {},
): RouteResult {
  const pool = agents.filter((a) => !opts.exclude?.includes(a.id));
  if (pool.length === 0) return { ok: false, reason: "no_agents", gaps: [] };
  const rank = (a: AgentSnapshot) => {
    const i = opts.prefer?.indexOf(a.id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  // Array.prototype.sort is stable, so ties keep registration order.
  const ordered = [...pool].sort((a, b) => rank(a) - rank(b));
  const gaps: CapabilityGap[] = ordered.map((a) => ({
    agentId: a.id,
    available: a.available,
    missing: missingFrom(a, required),
  }));
  const hit = ordered.find((a) => a.available && missingFrom(a, required).length === 0);
  if (hit) return { ok: true, agentId: hit.id };
  const capable = gaps.some((g) => g.missing.length === 0);
  return { ok: false, reason: capable ? "unavailable" : "missing_capabilities", gaps };
}

/** Reads availability and declared capabilities of every registered adapter. */
export async function snapshotAdapters(registry: AdapterRegistry): Promise<AgentSnapshot[]> {
  return Promise.all(
    registry.list().map(async (a) => ({
      id: a.id,
      available: await a.detect().catch(() => false),
      capabilities: await a.capabilities().catch(() => [] as AgentCapability[]),
    })),
  );
}

const LABELS: Record<AgentCapability, string> = {
  streaming: "phát kết quả theo luồng",
  session_resume: "tiếp tục phiên (resume)",
  tool_execution: "chạy công cụ",
  structured_output: "đầu ra có cấu trúc",
  approval: "luồng phê duyệt",
  interactive_terminal: "terminal tương tác",
  model_selection: "chọn model",
};

/** User-facing (Vietnamese) text for what an agent does not support; empty when nothing is missing. */
export function describeCapabilityGap(gap: CapabilityGap): string {
  const parts: string[] = [];
  if (!gap.available) parts.push("chưa cài hoặc không tìm thấy CLI");
  if (gap.missing.length > 0) {
    parts.push(`không hỗ trợ: ${gap.missing.map((c) => LABELS[c]).join(", ")}`);
  }
  return parts.length === 0 ? "" : `${gap.agentId} ${parts.join("; ")}`;
}
