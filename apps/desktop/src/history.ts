import type { HistoryFilter, HistoryRow } from "./api";

export const PAGE = 30;

/** Empty selects mean "any"; the sidecar rejects empty strings, so they are dropped here. */
export function toFilter(f: {
  projectId: string;
  agentId: string;
  state: string;
  offset: number;
}): HistoryFilter {
  return {
    ...(f.projectId ? { projectId: f.projectId } : {}),
    ...(f.agentId ? { agentId: f.agentId } : {}),
    ...(f.state ? { state: f.state as NonNullable<HistoryFilter["state"]> } : {}),
    limit: PAGE,
    offset: f.offset,
  };
}

/** Agents that appear in the loaded rows plus the known adapters, for the agent filter. */
export function agentsIn(rows: HistoryRow[], known: string[]): string[] {
  return [...new Set([...known, ...rows.flatMap((r) => (r.agentId ? [r.agentId] : []))])].sort();
}

export function whenText(iso: string, now = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toDateString() === now.toDateString()
    ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : t.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/** Search needs at least two characters, like the sidecar. */
export const searchable = (q: string): boolean => q.trim().length >= 2;
