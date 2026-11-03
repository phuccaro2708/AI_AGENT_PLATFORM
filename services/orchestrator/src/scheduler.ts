import type { Repo } from "@agent-studio/storage";

export interface SchedulerOptions {
  /** Default 2 (ROADMAP Phase 2). */
  maxConcurrent?: number;
  leaseMs?: number;
  now?: () => Date;
}

export interface SchedulerTick {
  /** Tasks whose worker stopped heartbeating → `needs_reconciliation` (never re-run automatically). */
  expired: string[];
  /** Tasks moved to `running` by this tick; the caller starts them. */
  started: string[];
  /** Queued tasks stuck behind a failed/cancelled dependency (surface to the user). */
  blocked: string[];
}

/** Picks ready tasks from the DAG. It does not run them: the caller owns execution and heartbeats. */
export class Scheduler {
  private readonly maxConcurrent: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly repo: Repo,
    opts: SchedulerOptions = {},
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.now = opts.now ?? (() => new Date());
  }

  tick(): SchedulerTick {
    const nowIso = this.now().toISOString();
    const expired = this.repo.expireLeases(nowIso);
    const started: string[] = [];
    for (;;) {
      const id = this.repo.claimNextReady({
        now: nowIso,
        leaseMs: this.leaseMs,
        maxConcurrent: this.maxConcurrent,
      });
      if (!id) break;
      started.push(id);
    }
    return { expired, started, blocked: this.repo.listBlockedTasks() };
  }

  heartbeat(taskId: string): boolean {
    return this.repo.heartbeat(taskId, this.now().toISOString(), this.leaseMs);
  }
}
