import type { RecoveryAction, RecoveryReport } from "./api";

export const RECOVERY_CHOICES: [RecoveryAction, string, string][] = [
  ["resume", "Keep what it did", "Accept the work as it is and continue with the next step"],
  ["retry", "Run it again", "Same task, attempt + 1; may repeat side effects"],
  ["abandon", "Abandon", "Cancel the task; nothing runs"],
];

/** One line saying what was found, in plain words. */
export function evidenceSummary(r: RecoveryReport): string {
  const e = r.evidence;
  const parts = [
    e.toolCalls === 0
      ? "no tool calls recorded"
      : `${e.toolCalls} tool call(s), ${e.unfinishedToolCalls} without a result`,
    !e.hasWorktree
      ? "no worktree"
      : e.worktreeChanged === null
        ? "worktree could not be read"
        : e.worktreeChanged
          ? "worktree has changes"
          : "worktree is clean",
  ];
  if (e.flaggedByPolicy) parts.push("flagged by the policy check");
  return parts.join(" · ");
}

/** Why the decision cannot be sent yet (null = it can). Mirrors what the sidecar enforces. */
export function recoveryBlocker(
  report: RecoveryReport | null,
  action: RecoveryAction | null,
  note: string,
  confirmed: boolean,
): string | null {
  if (report === null) return "Loading what the task left behind";
  if (action === null) return "Choose what to do with this task";
  const a = report.actions[action];
  if (!a.allowed) return a.why ?? "This choice is not available";
  if (note.trim().length < 3) return "Write what you checked (at least 3 characters)";
  if (a.confirmation && !confirmed) {
    return "Confirm that you checked the worktree: the side effects of this task are unverified";
  }
  return null;
}
