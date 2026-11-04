import type { Approval, ResolveDecision, WorkflowState, WorkflowTask } from "./api";

/** A Peer Review run as the UI remembers it; tasks and state always come from `tasks.list`. */
export interface PeerRun {
  workflowId: string;
  projectId: string;
  goal: string;
  implementer: string;
  reviewer: string;
}

const KEY = "agent-studio.peer-runs";

export function parseRuns(raw: string | null): PeerRun[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is PeerRun =>
        typeof r === "object" &&
        r !== null &&
        ["workflowId", "projectId", "goal", "implementer", "reviewer"].every(
          (k) => typeof (r as Record<string, unknown>)[k] === "string",
        ),
    );
  } catch {
    return [];
  }
}

/** Run ids are kept so sessions survive a restart; the sidecar database is the source of truth. */
export function loadRuns(): PeerRun[] {
  try {
    return parseRuns(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function saveRuns(runs: PeerRun[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(runs.slice(0, 50)));
  } catch {
    // storage may be unavailable; the run still works for this session
  }
}

export type Role = "implementer" | "reviewer";

/** Tasks alternate implement, review, implement, ... in creation order. */
export function roleOf(index: number): Role {
  return index % 2 === 0 ? "implementer" : "reviewer";
}

export interface Row {
  task: WorkflowTask;
  role: Role;
  /** 1-based round (one implement + one review). */
  round: number;
}

export function boardRows(tasks: WorkflowTask[]): Row[] {
  return tasks.map((task, i) => ({ task, role: roleOf(i), round: Math.floor(i / 2) + 1 }));
}

/** The latest implementer task: the one whose worktree diff is worth showing. */
export function diffTask(rows: Row[]): WorkflowTask | undefined {
  return rows.filter((r) => r.role === "implementer").at(-1)?.task;
}

export const workflowDone = (s: WorkflowState): boolean =>
  s === "completed" || s === "failed" || s === "cancelled";

export function approvalText(a: Approval): string {
  try {
    const v: unknown = JSON.parse(a.requestJson);
    const d = (v as { description?: unknown } | null)?.description;
    return typeof d === "string" ? d : a.requestJson;
  } catch {
    return a.requestJson;
  }
}

/** Answered or expired requests, newest first, at most 20 (the decision log shown under the cards). */
export function decisionLog(all: Approval[]): Approval[] {
  return all
    .filter((a) => a.state !== "pending")
    .sort((x, y) => (y.resolvedAt ?? y.createdAt).localeCompare(x.resolvedAt ?? x.createdAt))
    .slice(0, 20);
}

/** Pending approvals that belong to this run's tasks. */
export function approvalsFor(approvals: Approval[], tasks: WorkflowTask[]): Approval[] {
  const ids = new Set(tasks.map((t) => t.id));
  return approvals.filter((a) => a.state === "pending" && ids.has(a.taskId));
}

/** Rows whose task stopped with unknown side effects: nothing continues until a person decides. */
export const awaitingDecision = (rows: Row[]): Row[] =>
  rows.filter((r) => r.task.state === "needs_reconciliation");

/** Why the decision cannot be sent yet (null = it can). `requeue` also needs an explicit confirmation. */
export function resolutionBlocker(
  decision: ResolveDecision | null,
  note: string,
  confirmedRequeue: boolean,
): string | null {
  if (decision === null) return "Choose what happened to this task";
  if (note.trim().length < 3) return "Write what you checked (at least 3 characters)";
  if (decision === "requeue" && !confirmedRequeue) {
    return "Confirm that you checked the worktree: running again may repeat side effects";
  }
  return null;
}
