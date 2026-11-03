import type { Repo } from "@agent-studio/storage";
import { newId } from "@agent-studio/shared-utils";

export type ApprovalDecision = "approved" | "denied" | "expired";

/** What the agent wants to do. Free-form on purpose: it is shown to a human, never interpreted. */
export interface ApprovalRequest {
  kind: string;
  summary: string;
  detail?: unknown;
}

export interface ApprovalCenterOptions {
  /** How long a request stays answerable. Default 10 minutes; a "yes" after that counts as expired. */
  ttlMs?: number;
  /** Lease given back to the task when it resumes. Default 60 s. */
  leaseMs?: number;
  now?: () => Date;
  /** Told about every new request and every decision (the sidecar turns these into pushed events). */
  onChange?: (c: {
    approvalId: string;
    taskId: string;
    state: "pending" | ApprovalDecision;
  }) => void;
}

/**
 * Human-in-the-loop gate. `request` parks the task in `waiting_approval` and returns a promise that
 * settles when someone calls `resolve` (or the deadline passes via `expireDue`). The decision is
 * persisted first, so a crash never loses it; the in-memory promise is only the wake-up. After a
 * restart nothing is waiting: `Repo.recoverInterruptedTasks` expires the leftover rows.
 *
 * Not yet enforced: there is no authentication of `by`, and no adapter can receive an answer yet
 * (current adapters are read-only). This is the backend half that Phase 4/7 build on.
 */
export class ApprovalCenter {
  private readonly ttlMs: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly onChange: ApprovalCenterOptions["onChange"];
  private readonly waiters = new Map<string, (d: ApprovalDecision) => void>();

  constructor(
    private readonly repo: Repo,
    opts: ApprovalCenterOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.now = opts.now ?? (() => new Date());
    this.onChange = opts.onChange;
  }

  request(
    taskId: string,
    request: ApprovalRequest,
    o: { ttlMs?: number } = {},
  ): { id: string; decision: Promise<ApprovalDecision> } {
    const task = this.repo.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const expiresAt = new Date(this.now().getTime() + (o.ttlMs ?? this.ttlMs)).toISOString();
    const id = this.repo.createApproval({
      taskId,
      request,
      expiresAt,
      nowIso: this.now().toISOString(),
    }); // throws unless running
    const decision = new Promise<ApprovalDecision>((resolve) => this.waiters.set(id, resolve));
    this.repo.appendMessage(
      {
        id: newId("msg"),
        schemaVersion: 1,
        workflowId: task.workflowId,
        taskId,
        correlationId: id,
        fromAgent: task.agentId ?? "unknown",
        toAgent: "orchestrator",
        type: "approval.request",
        payload: { approvalId: id, expiresAt, request, source: "agent-reported" },
        createdAt: this.now().toISOString(),
      },
      this.repo.nextMessageSequence(taskId),
    );
    this.notify(id, taskId, "pending");
    return { id, decision };
  }

  /** `approvals.resolve`. False when unknown or already decided (the first answer wins). */
  resolve(id: string, decision: "approved" | "denied", by: string, reason?: string): boolean {
    return this.settle(id, decision, by, reason) !== undefined;
  }

  /** Expires every pending approval past its deadline; returns their ids. */
  expireDue(): string[] {
    const due = this.repo.listDueApprovals(this.now().toISOString());
    return due.filter((id) => this.settle(id, "expired", "system:expired") !== undefined);
  }

  /** The task ended or was cancelled: its open requests can no longer be answered. */
  cancelForTask(taskId: string): string[] {
    return this.repo
      .listPendingApprovals(taskId)
      .map((a) => a.id)
      .filter((id) => this.settle(id, "denied", "system:task-ended", "task ended") !== undefined);
  }

  listPending(taskId?: string) {
    return this.repo.listPendingApprovals(taskId).map((a) => ({
      id: a.id,
      taskId: a.taskId,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      request: JSON.parse(a.requestJson) as ApprovalRequest,
    }));
  }

  private settle(
    id: string,
    decision: ApprovalDecision,
    by: string,
    reason?: string,
  ): ApprovalDecision | undefined {
    const final = this.repo.resolveApproval(id, decision, {
      by,
      ...(reason ? { reason } : {}),
      nowIso: this.now().toISOString(),
      leaseMs: this.leaseMs,
    });
    if (final) {
      this.waiters.get(id)?.(final);
      this.waiters.delete(id);
      const taskId = this.repo.getApproval(id)?.taskId;
      if (taskId) this.notify(id, taskId, final);
    }
    return final;
  }

  private notify(approvalId: string, taskId: string, state: "pending" | ApprovalDecision): void {
    try {
      this.onChange?.({ approvalId, taskId, state });
    } catch {
      // a throwing listener must never affect the decision
    }
  }
}
