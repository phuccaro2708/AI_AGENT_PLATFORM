import { newId } from "@agent-studio/shared-utils";
import type { Repo } from "@agent-studio/storage";

export interface ApprovalServiceOptions {
  repo: Repo;
  clock?: () => Date;
  /** How long a request stays open. Default 15 minutes. */
  defaultTtlMs?: number;
}

/**
 * Human-in-the-loop gate for a running task. An approval is a decision record plus a task state change
 * (`running` <-> `waiting_approval`); it is NOT a sandbox: it only stops the orchestrator from going on
 * until a person answers, and nothing here limits what an agent process can already do.
 *
 * Outcomes: approved -> the task resumes (`running`); denied -> `failed`; expired -> `needs_reconciliation`
 * (the task stopped mid-run, so its side effects are unknown and it is never resumed or retried on its own).
 */
export class ApprovalService {
  private readonly repo: Repo;
  private readonly clock: () => Date;
  private readonly defaultTtlMs: number;

  constructor(opts: ApprovalServiceOptions) {
    this.repo = opts.repo;
    this.clock = opts.clock ?? (() => new Date());
    this.defaultTtlMs = opts.defaultTtlMs ?? 15 * 60_000;
  }

  /** The task must be `running`. State change, approval row and `approval.request` message commit together. */
  request(taskId: string, description: string, opts: { ttlMs?: number } = {}): string {
    const expiresAt = new Date(
      this.clock().getTime() + (opts.ttlMs ?? this.defaultTtlMs),
    ).toISOString();
    return this.repo.tx((r) => {
      const task = r.getTask(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      r.setTaskState(taskId, "waiting_approval", { reason: `approval requested: ${description}` });
      const approvalId = r.createApproval(taskId, { description }, expiresAt);
      r.appendMessageAuto({
        id: newId("msg"),
        schemaVersion: 1,
        workflowId: task.workflowId,
        taskId,
        correlationId: newId("corr"),
        fromAgent: task.agentId ?? "orchestrator",
        toAgent: "user",
        type: "approval.request",
        payload: { approvalId, description },
        createdAt: this.clock().toISOString(),
      });
      return approvalId;
    });
  }

  /** Answers a pending approval exactly once. An overdue request is rejected here; `expireDue` settles it. */
  resolve(approvalId: string, decision: "approved" | "denied", note?: string): void {
    this.repo.tx((r) => {
      const approval = r.getApproval(approvalId);
      if (!approval) throw new Error(`Unknown approval: ${approvalId}`);
      if (approval.expiresAt !== null && approval.expiresAt < this.clock().toISOString()) {
        throw new Error(`Approval has expired: ${approvalId}`);
      }
      r.resolveApproval(approvalId, decision);
      const suffix = note ? `: ${note}` : "";
      if (decision === "approved") {
        r.setTaskState(approval.taskId, "running", { reason: `approved${suffix}` });
      } else {
        r.setTaskState(approval.taskId, "failed", { reason: `approval denied${suffix}` });
      }
    });
  }

  /** Expires every pending approval that is overdue; returns their ids. Call from a timer. */
  expireDue(): string[] {
    const due = this.repo.expireApprovals(this.clock().toISOString());
    for (const id of due) {
      const approval = this.repo.getApproval(id);
      if (approval && this.repo.getTaskState(approval.taskId) === "waiting_approval") {
        this.repo.setTaskState(approval.taskId, "needs_reconciliation", {
          reason: "approval expired while the task was waiting: side effects unknown",
        });
      }
    }
    return due;
  }
}
