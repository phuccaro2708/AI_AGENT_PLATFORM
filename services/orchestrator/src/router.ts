import { AgentMessage } from "@agent-studio/contracts";
import type { Repo } from "@agent-studio/storage";

export type RouterFailpoint =
  "send:before-commit" | "deliver:after-receive" | "deliver:after-handler";

export interface RouterOptions {
  repo: Repo;
  clock?: () => Date;
  /** Uniform [0,1); injected so retry timing is testable. */
  random?: () => number;
  /** Attempts before a message is dead-lettered. Default 5. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Rows taken per tick. Default 20. */
  batchSize?: number;
  /** `send` throws `BackpressureError` once this many messages are undelivered for one destination. */
  maxPendingPerConsumer?: number;
  /** Test hook: throwing here simulates the process dying at that point (never counted as a failed attempt). */
  failpoint?: (point: RouterFailpoint) => void;
}

export type Handler = (message: AgentMessage) => void | Promise<void>;

export class BackpressureError extends Error {
  constructor(readonly toAgent: string) {
    super(`Too many undelivered messages for ${toAgent}`);
    this.name = "BackpressureError";
  }
}

export interface TickResult {
  delivered: number;
  retried: number;
  deadLettered: number;
  /** True when another tick was already running. */
  skipped?: true;
}

/**
 * Durable in-process message router. The message row and its outbox row are written in one
 * transaction (`send`); `tick` then delivers from the committed outbox.
 *
 * Guarantees: at-least-once delivery per (message, consumer). A crash after the handler ran but before
 * the ack repeats the handler, so handlers must be idempotent (key on `message.id`). A message that was
 * acked is never handled again. Retry and dead-lettering apply to *delivery* only; they never re-run a
 * task (CLAUDE.md #6). This is an internal bus, not an A2A implementation.
 */
export class MessageRouter {
  private readonly repo: Repo;
  private readonly clock: () => Date;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly batchSize: number;
  private readonly maxPending: number;
  private readonly failpoint: (point: RouterFailpoint) => void;
  private readonly handlers = new Map<string, Handler>();
  private ticking = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: RouterOptions) {
    this.repo = opts.repo;
    this.clock = opts.clock ?? (() => new Date());
    this.random = opts.random ?? Math.random;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.batchSize = opts.batchSize ?? 20;
    this.maxPending = opts.maxPendingPerConsumer ?? Number.POSITIVE_INFINITY;
    this.failpoint = opts.failpoint ?? (() => undefined);
  }

  /** One handler per consumer id (the `toAgent` of the messages it receives). */
  register(consumer: string, handler: Handler): void {
    this.handlers.set(consumer, handler);
  }

  /** Persists the message (sequence from the DB) and its outbox row atomically. Duplicate ids are a no-op. */
  send(input: Omit<AgentMessage, "sequence">): { message: AgentMessage; duplicate: boolean } {
    return this.repo.tx((r) => {
      const existing = r.getOutbox(input.id);
      if (existing) {
        return { message: AgentMessage.parse(JSON.parse(existing.payloadJson)), duplicate: true };
      }
      if (r.countPendingOutbox(input.toAgent) >= this.maxPending) {
        throw new BackpressureError(input.toAgent);
      }
      const message = r.appendMessageAuto(input);
      r.enqueueOutbox({
        messageId: message.id,
        taskId: message.taskId,
        toAgent: message.toAgent,
        payload: message,
        nextAttemptAt: this.clock().toISOString(),
      });
      this.failpoint("send:before-commit");
      return { message, duplicate: false };
    });
  }

  /** Delivers every due message once. Not reentrant: a concurrent call returns `skipped`. */
  async tick(): Promise<TickResult> {
    const result: TickResult = { delivered: 0, retried: 0, deadLettered: 0 };
    if (this.ticking) return { ...result, skipped: true };
    this.ticking = true;
    try {
      const due = this.repo.listDueOutbox(this.clock().toISOString(), this.batchSize);
      for (const row of due) {
        const message = AgentMessage.parse(JSON.parse(row.payloadJson));
        const consumer = row.toAgent;
        const handler = this.handlers.get(consumer);
        if (!handler) {
          this.fail(row.id, row.attempts, `no consumer registered for ${consumer}`, result);
          continue;
        }
        // A fresh receive means "not seen"; an existing unacked one means a crash left it half-done.
        const firstTime = this.repo.receiveInbox(message.id, consumer);
        this.failpoint("deliver:after-receive");
        const alreadyAcked = !firstTime && this.repo.isInboxAcked(message.id, consumer);
        if (!alreadyAcked) {
          try {
            await handler(message);
          } catch (e) {
            this.fail(row.id, row.attempts, e instanceof Error ? e.message : String(e), result);
            continue;
          }
          this.failpoint("deliver:after-handler");
        }
        this.repo.tx((r) => {
          r.ackInbox(message.id, consumer);
          r.markOutboxDelivered(row.id);
        });
        result.delivered++;
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }

  /** Polls `tick` on an interval until `stop`. Errors are swallowed here; they surface through `tick`. */
  start(intervalMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private fail(rowId: string, attempts: number, error: string, result: TickResult): void {
    // Equal jitter: half the capped exponential delay is fixed, half is random.
    const cap = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempts);
    const delay = Math.round(cap / 2 + (cap / 2) * this.random());
    const next = new Date(this.clock().getTime() + delay).toISOString();
    const status = this.repo.markOutboxFailed(rowId, error, next, this.maxAttempts);
    if (status === "dead_letter") result.deadLettered++;
    else result.retried++;
  }
}
