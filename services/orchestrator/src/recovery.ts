import type { AgentMessage, TaskState } from "@agent-studio/contracts";

/**
 * Recovery of a `needs_reconciliation` task, in five steps (the plan names the number, not the steps; the
 * chosen steps are in docs/ASSUMPTIONS.md, "P4-8 Recovery in five steps"):
 *
 *  1. DETECT   - at start-up `Repo.recoverInterruptedTasks` moves tasks that were in progress to
 *                `needs_reconciliation` (the orchestrator stopped; the CLI process may have written anything).
 *  2. INSPECT  - `recovery.inspect` collects evidence without changing anything: stored messages, tool calls
 *                that never got a result, whether the task's worktree has changes.
 *  3. CLASSIFY - from that evidence alone: `no_evidence_of_side_effects` or `side_effects_unverified`. A
 *                classification is a hint for the person, never a proof and never an automatic action.
 *  4. DECIDE   - only a person, via `recovery.resolve`: resume (accept what exists and continue the
 *                workflow), retry (run the task again, attempt + 1) or abandon (cancel). The unsafe
 *                combinations are refused unless the person confirmed they checked.
 *  5. RECORD   - the decision, the note and an evidence summary go into the task's state reason (the audit
 *                trail) and a `task.state` event; the workflow engine is told so a resumed task hands over.
 *
 * Nothing in this file runs a task. Side effects that cannot be verified never lead to an automatic retry.
 */

export type Classification = "no_evidence_of_side_effects" | "side_effects_unverified";
export type RecoveryAction = "resume" | "retry" | "abandon";

export interface RecoveryEvidence {
  messageCount: number;
  /** Messages other than the initial request, i.e. output the task actually produced. */
  producedOutput: boolean;
  toolCalls: number;
  /** Tool calls without a matching result: the tool may have been running when the process died. */
  unfinishedToolCalls: number;
  /** The prompt was stored (`task.request` or `task.accepted`), so a retry has something to run. */
  hasStoredPrompt: boolean;
  hasWorktree: boolean;
  /** null: no worktree, or it could not be read. */
  worktreeChanged: boolean | null;
  /** The policy gate flagged the run (it may have gone beyond what it was granted). */
  flaggedByPolicy: boolean;
}

export interface ActionPlan {
  allowed: boolean;
  /** The person must say they checked before this action is accepted. */
  confirmation: boolean;
  why?: string;
}

export interface RecoveryReport {
  taskId: string;
  state: TaskState;
  attempt: number;
  evidence: RecoveryEvidence;
  classification: Classification;
  actions: Record<RecoveryAction, ActionPlan>;
}

/** Pairs tool calls with results the way `classifyOutcome` does: by callId when given, otherwise by counting. */
export function countToolCalls(payloads: readonly unknown[]): {
  calls: number;
  unfinished: number;
} {
  const open = new Set<string>();
  let calls = 0;
  let anonCalls = 0;
  let anonResults = 0;
  for (const p of payloads) {
    const e = p as { type?: unknown; callId?: unknown } | null;
    if (e?.type === "tool_call") {
      calls++;
      if (typeof e.callId === "string") open.add(e.callId);
      else anonCalls++;
    } else if (e?.type === "tool_result") {
      if (typeof e.callId === "string") open.delete(e.callId);
      else anonResults++;
    }
  }
  return { calls, unfinished: open.size + Math.max(0, anonCalls - anonResults) };
}

export function buildEvidence(
  messages: readonly AgentMessage[],
  worktree: { has: boolean; changed: boolean | null },
): RecoveryEvidence {
  const events = messages.filter((m) => m.type === "task.progress").map((m) => m.payload);
  const { calls, unfinished } = countToolCalls(events);
  const flagged = events.some((p) => {
    const e = p as { type?: unknown; needsReconciliation?: unknown } | null;
    return e?.type === "error" && e.needsReconciliation === true;
  });
  return {
    messageCount: messages.length,
    producedOutput: messages.some((m) => m.type !== "task.request" && m.type !== "task.accepted"),
    hasStoredPrompt: messages.some((m) => m.type === "task.request" || m.type === "task.accepted"),
    toolCalls: calls,
    unfinishedToolCalls: unfinished,
    hasWorktree: worktree.has,
    worktreeChanged: worktree.changed,
    flaggedByPolicy: flagged,
  };
}

export function classify(e: RecoveryEvidence): Classification {
  // An unreadable worktree (changed === null while one exists) is not evidence that nothing changed.
  const worktreeClean = !e.hasWorktree || e.worktreeChanged === false;
  return e.toolCalls === 0 && !e.flaggedByPolicy && worktreeClean
    ? "no_evidence_of_side_effects"
    : "side_effects_unverified";
}

export function buildReport(input: {
  taskId: string;
  state: TaskState;
  attempt: number;
  evidence: RecoveryEvidence;
}): RecoveryReport {
  const { evidence } = input;
  const classification = classify(evidence);
  const unverified = classification === "side_effects_unverified";
  const waiting = input.state === "needs_reconciliation";
  const notWaiting = waiting ? {} : { why: `the task is ${input.state}, not needs_reconciliation` };
  const resumable = waiting && evidence.producedOutput;
  return {
    taskId: input.taskId,
    state: input.state,
    attempt: input.attempt,
    evidence,
    classification,
    actions: {
      resume: {
        allowed: resumable,
        confirmation: unverified,
        ...(resumable
          ? {}
          : {
              why: waiting
                ? "the task produced no output, so there is nothing to continue from"
                : notWaiting.why!,
            }),
      },
      retry: {
        allowed: waiting && evidence.hasStoredPrompt,
        confirmation: unverified,
        ...(!waiting
          ? notWaiting
          : evidence.hasStoredPrompt
            ? {}
            : { why: "no prompt was stored for this task, so there is nothing to run again" }),
      },
      abandon: { allowed: waiting, confirmation: false, ...notWaiting },
    },
  };
}

/** Maps the action to the stored decision and refuses what the report does not allow. Throws with the reason. */
export function planResolution(
  report: RecoveryReport,
  action: RecoveryAction,
  confirmUnverified: boolean,
): "completed" | "requeue" | "cancelled" {
  const a = report.actions[action];
  if (!a.allowed) {
    throw new Error(`Cannot ${action} task ${report.taskId}: ${a.why ?? "not allowed"}`);
  }
  if (a.confirmation && !confirmUnverified) {
    throw new Error(
      `Cannot ${action} task ${report.taskId} without confirmation: its side effects are unverified ` +
        "(tool calls, worktree changes or a policy flag). Check the worktree, then confirm.",
    );
  }
  return action === "resume" ? "completed" : action === "retry" ? "requeue" : "cancelled";
}

/** One line for the audit trail: what the person decided and what the evidence looked like. */
export function auditNote(report: RecoveryReport, action: RecoveryAction, note: string): string {
  const e = report.evidence;
  const tree = !e.hasWorktree
    ? "none"
    : e.worktreeChanged === null
      ? "unreadable"
      : e.worktreeChanged
        ? "changed"
        : "clean";
  return (
    `${action} (${report.classification}; tool calls ${e.toolCalls}, unfinished ${e.unfinishedToolCalls}, ` +
    `worktree ${tree}): ${note}`
  );
}
