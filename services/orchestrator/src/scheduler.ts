import type { Repo } from "@agent-studio/storage";
import type { Orchestrator, RunResult } from "./orchestrator.js";

/**
 * Optional brake on how many tasks may run at once (e.g. a resource monitor). Must be cheap and synchronous:
 * it is called on every tick. It can only lower the limit: the scheduler never exceeds `concurrency`, and a
 * result <= 0 starts nothing. It never touches tasks already running.
 */
export interface SchedulerAdmission {
  maxConcurrency(base: number): number;
}

export interface SchedulerOptions {
  repo: Repo;
  orchestrator: Orchestrator;
  clock?: () => Date;
  /** Tasks running at once. Default 2. */
  concurrency?: number;
  admission?: SchedulerAdmission;
  /** A claimed task must be heartbeated within this window or its owner is presumed dead. Default 60s. */
  leaseMs?: number;
  /**
   * After a task the scheduler ran has settled (`result` is absent when `execute` threw, leaving the task
   * to its lease). A throwing listener never affects the scheduler. Used by the workflow engine to hand off.
   */
  onSettled?: (taskId: string, result: RunResult | undefined) => void | Promise<void>;
}

export interface SchedulerTick {
  started: string[];
  /** Tasks whose lease ran out and were moved to `needs_reconciliation`. */
  expired: string[];
  /** Queued tasks cancelled because a dependency ended `failed` or `cancelled`. */
  cancelled: string[];
}

/**
 * Picks ready tasks (queued, dependencies completed) by priority and runs them up to `concurrency`.
 *
 * Re-run rules (CLAUDE.md #6): only a `queued` task is ever claimed. A `running` task whose lease expired
 * had an owner that died mid-flight, so its side effects are unknown: it becomes `needs_reconciliation`
 * and is never started again here. Only an explicit `resolveReconciliation("requeue")` puts it back.
 */
export class Scheduler {
  private readonly repo: Repo;
  private readonly orchestrator: Orchestrator;
  private readonly clock: () => Date;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly admission: SchedulerAdmission | undefined;
  private readonly onSettled: SchedulerOptions["onSettled"];
  private readonly running = new Map<string, { done: Promise<void>; abort: AbortController }>();
  private timers: NodeJS.Timeout[] = [];

  constructor(opts: SchedulerOptions) {
    this.repo = opts.repo;
    this.orchestrator = opts.orchestrator;
    this.clock = opts.clock ?? (() => new Date());
    this.concurrency = opts.concurrency ?? 2;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.admission = opts.admission;
    this.onSettled = opts.onSettled;
  }

  private leaseUntil(): string {
    return new Date(this.clock().getTime() + this.leaseMs).toISOString();
  }

  async tick(): Promise<SchedulerTick> {
    const result: SchedulerTick = { started: [], expired: [], cancelled: [] };

    for (const id of this.repo.listExpiredLeases(this.clock().toISOString())) {
      if (this.running.has(id)) continue; // ours and alive; the heartbeat is just late
      this.repo.setTaskState(id, "needs_reconciliation", {
        reason:
          "lease expired: the worker running this task stopped reporting, side effects unknown",
      });
      result.expired.push(id);
    }

    for (const id of this.repo.listTasksBlockedByFailure()) {
      this.repo.setTaskState(id, "cancelled", { reason: "a dependency failed or was cancelled" });
      result.cancelled.push(id);
    }

    const limit = this.admission
      ? Math.min(this.concurrency, this.admission.maxConcurrency(this.concurrency))
      : this.concurrency;
    const free = limit - this.running.size;
    if (free <= 0) return result;
    for (const id of this.repo.listReadyTasks(free)) {
      if (!this.repo.claimTask(id, this.leaseUntil())) continue; // another scheduler won it
      const abort = new AbortController();
      const done = this.orchestrator
        .execute(id, { signal: abort.signal })
        .catch(() => undefined) // execute settles task state itself; a throw leaves it for the lease
        .then(async (r) => {
          try {
            await this.onSettled?.(id, r);
          } catch {
            // see SchedulerOptions.onSettled
          }
        })
        .finally(() => this.running.delete(id));
      this.running.set(id, { done, abort });
      result.started.push(id);
    }
    return result;
  }

  /** Aborts a task this scheduler is running; false when it is not running here. */
  cancel(taskId: string): boolean {
    const r = this.running.get(taskId);
    if (!r) return false;
    r.abort.abort();
    return true;
  }

  /** Extends the lease of every task this scheduler is running. */
  heartbeat(): void {
    for (const id of this.running.keys()) this.repo.extendLease(id, this.leaseUntil());
  }

  /** Resolves when nothing is running. */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()].map((r) => r.done));
    }
  }

  start(intervalMs = 500): void {
    if (this.timers.length > 0) return;
    const tick = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    const beat = setInterval(() => this.heartbeat(), Math.max(1, Math.floor(this.leaseMs / 3)));
    tick.unref();
    beat.unref();
    this.timers = [tick, beat];
  }

  /** Stops polling and aborts running tasks (they settle through the normal cancel path). */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const r of this.running.values()) r.abort.abort();
  }
}
