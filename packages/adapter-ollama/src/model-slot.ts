/**
 * One Ollama model loaded at a time per server (a small GPU cannot hold two). Runs of the SAME model share the
 * slot; a run of ANOTHER model waits until every active run has finished. Strict first-come order: a run never
 * overtakes an earlier waiter, so a different model cannot be starved by a stream of runs of the current one.
 *
 * Scope: this serialises what THIS process sends. Another program talking to the same Ollama is not seen.
 */
export class ModelSlot {
  private model: string | undefined;
  private active = 0;
  private lastUsed: string | undefined;
  private readonly queue: { model: string; grant: (release: () => void) => void }[] = [];

  /** Waits for the slot, then returns a release function (call it once). Rejects when `signal` aborts first. */
  acquire(model: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted)
      return Promise.reject(new Error("aborted while waiting for the model slot"));
    if (this.queue.length === 0 && this.canEnter(model)) return Promise.resolve(this.enter(model));
    return new Promise((resolve, reject) => {
      const waiter = {
        model,
        grant: (release: () => void) => {
          signal.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error("aborted while waiting for the model slot"));
        this.pump(); // the aborted run may have been the one blocking the others
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  /**
   * Call right after `acquire` resolves. Records `model` as the one this process now has loaded and returns the model
   * it loaded before when that is a DIFFERENT one (the caller should unload it, so two models never sit in memory
   * together). `undefined` = nothing to unload. Only what this process loaded is known.
   */
  switchTo(model: string): string | undefined {
    const prev = this.lastUsed;
    this.lastUsed = model;
    return prev !== undefined && prev !== model ? prev : undefined;
  }

  /** Model currently held (`undefined` when idle), how many runs hold it, and how many wait. */
  state(): { model: string | undefined; active: number; waiting: number } {
    return { model: this.model, active: this.active, waiting: this.queue.length };
  }

  private canEnter(model: string): boolean {
    return this.active === 0 || this.model === model;
  }

  private enter(model: string): () => void {
    this.model = model;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (this.active === 0) this.model = undefined;
      this.pump();
    };
  }

  /** Hands the slot to waiters in order while the head of the queue may enter. */
  private pump(): void {
    while (this.queue.length > 0 && this.canEnter(this.queue[0]!.model)) {
      const w = this.queue.shift()!;
      w.grant(this.enter(w.model));
    }
  }
}

const slots = new Map<string, ModelSlot>();
/** The slot of one server (by its normalised origin), shared by every adapter that talks to it. */
export function slotFor(baseUrl: string): ModelSlot {
  let s = slots.get(baseUrl);
  if (!s) slots.set(baseUrl, (s = new ModelSlot()));
  return s;
}
