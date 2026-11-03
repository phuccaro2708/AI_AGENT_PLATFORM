import type { AgentMessage } from "@agent-studio/contracts";
import type { Repo } from "@agent-studio/storage";

const BASE_MS = 1000;
const CAP_MS = 60_000;

/**
 * Exponential backoff with full jitter: delay = rand() * min(cap, base * 2^attempt).
 * `attempt` is the number of failures so far (0 for the first). `rand` returns [0,1].
 */
export function backoffMs(attempt: number, rand: () => number): number {
  return Math.floor(rand() * Math.min(CAP_MS, BASE_MS * 2 ** attempt));
}

export type DeliveryHandler = (message: AgentMessage) => Promise<void>;

export interface RouterOptions {
  maxAttempts?: number;
  /** Backpressure: deliveries handled per tick. */
  batchSize?: number;
  now?: () => Date;
  rand?: () => number;
}

export interface TickResult {
  delivered: number;
  retried: number;
  dead: number;
  duplicates: number;
}

/**
 * At-least-once router over the outbox. Handlers MUST be idempotent: a crash after the handler ran
 * but before the delivery is marked is redelivered; the inbox only suppresses repeats that were
 * recorded as accepted.
 */
export class Router {
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly rand: () => number;

  constructor(
    private readonly repo: Repo,
    private readonly handlerFor: (recipient: string) => DeliveryHandler,
    opts: RouterOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.batchSize = opts.batchSize ?? 20;
    this.now = opts.now ?? (() => new Date());
    this.rand = opts.rand ?? Math.random;
  }

  async deliverDue(): Promise<TickResult> {
    const result: TickResult = { delivered: 0, retried: 0, dead: 0, duplicates: 0 };
    const nowIso = this.now().toISOString();
    for (const d of this.repo.claimDueDeliveries(nowIso, this.batchSize)) {
      if (this.repo.hasInbound(d.recipient, d.messageId)) {
        this.repo.markDelivered(d.id, nowIso);
        result.duplicates++;
        continue;
      }
      try {
        const message = this.repo.getMessage(d.messageId);
        if (!message) throw new Error(`message ${d.messageId} missing`);
        await this.handlerFor(d.recipient)(message);
        this.repo.acceptInbound(d.recipient, d.messageId, nowIso);
        this.repo.markDelivered(d.id, nowIso);
        result.delivered++;
      } catch (e) {
        const next = new Date(
          this.now().getTime() + backoffMs(d.attempts, this.rand),
        ).toISOString();
        const state = this.repo.recordDeliveryFailure(
          d.id,
          e instanceof Error ? e.message : String(e),
          next,
          this.maxAttempts,
        );
        if (state === "dead") result.dead++;
        else result.retried++;
      }
    }
    return result;
  }
}
