import { describe, expect, it } from "vitest";
import {
  validateCapabilities,
  validateEventStream,
  type AgentAdapter,
  type AgentTask,
} from "@agent-studio/agent-core";
import type { AgentEvent } from "@agent-studio/contracts";

/**
 * Shared adapter contract suite (C1). Every adapter (stub, claude, codex) runs this.
 * It uses only the AgentAdapter interface and checks nothing about any specific CLI.
 * A real adapter may pass `task` to point at a harmless prompt/cwd for its environment.
 */
export interface ContractOptions {
  make: () => AgentAdapter | Promise<AgentAdapter>;
  task?: (id: string, signal: AbortSignal) => AgentTask;
  /** Skip tests that need the underlying CLI (e.g. adapter not installed on this machine). */
  skip?: boolean;
}

const defaultTask = (id: string, signal: AbortSignal): AgentTask => ({
  id,
  prompt: "contract test",
  cwd: process.cwd(),
  signal,
});

async function collect(it: AsyncIterable<AgentEvent>, onEach?: (e: AgentEvent, i: number) => void) {
  const out: AgentEvent[] = [];
  let i = 0;
  for await (const e of it) {
    out.push(e);
    onEach?.(e, i++);
  }
  return out;
}

export function describeAdapterContract(name: string, o: ContractOptions): void {
  const task = o.task ?? defaultTask;
  const d = o.skip ? describe.skip : describe;
  d(`adapter contract: ${name}`, () => {
    it("has a non-empty id and valid, unique capabilities", async () => {
      const a = await o.make();
      expect(a.id.length).toBeGreaterThan(0);
      expect(validateCapabilities(await a.capabilities())).toEqual([]);
    });

    it("detect() resolves to a boolean and never throws", async () => {
      const a = await o.make();
      expect(typeof (await a.detect())).toBe("boolean");
    });

    it("execute() yields valid events ending in exactly one terminal event", async () => {
      const a = await o.make();
      const events = await collect(a.execute(task("c-1", new AbortController().signal)));
      expect(validateEventStream(events)).toEqual([]);
    });

    it("an already-aborted signal ends with the terminal error 'cancelled'", async () => {
      const a = await o.make();
      const ac = new AbortController();
      ac.abort();
      const events = await collect(a.execute(task("c-2", ac.signal)));
      expect(validateEventStream(events)).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "error", message: "cancelled" });
    });

    it("aborting mid-stream ends with 'cancelled' and nothing after it", async () => {
      const a = await o.make();
      const ac = new AbortController();
      const events = await collect(a.execute(task("c-3", ac.signal)), (_e, i) => {
        if (i === 0) ac.abort();
      });
      expect(validateEventStream(events)).toEqual([]);
      // An adapter may finish before it notices the abort; if it did not, it must report cancellation.
      const last = events.at(-1);
      expect(
        last?.type === "completed" || (last?.type === "error" && last.message === "cancelled"),
      ).toBe(true);
    });

    it("cancel() is idempotent and tolerates unknown task ids", async () => {
      const a = await o.make();
      await expect(a.cancel("never-started")).resolves.toBeUndefined();
      await expect(a.cancel("never-started")).resolves.toBeUndefined();
    });

    it("does not mutate the task it was given", async () => {
      const a = await o.make();
      const t = task("c-4", new AbortController().signal);
      const before = JSON.stringify({ ...t, signal: undefined });
      await collect(a.execute(t));
      expect(JSON.stringify({ ...t, signal: undefined })).toBe(before);
    });
  });
}
