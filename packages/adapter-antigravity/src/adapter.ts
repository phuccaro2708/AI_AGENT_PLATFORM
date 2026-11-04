import type { AgentCapability, AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import {
  createLineSplitter,
  resolveExecutable,
  startProcess,
  type RunningProcess,
} from "@agent-studio/process-manager";
import { createAntigravityParser } from "./parse.js";

const isJson = (line: string): boolean => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

const invalidNote = (n: number): string =>
  n > 0 ? ` (${n} output line${n === 1 ? "" : "s"} were not valid JSON)` : "";

export interface AntigravityAdapterOptions {
  id?: string;
  /** Executable name or path. Default `agy`. */
  command?: string;
  /** Arguments placed first (tests: the fake CLI script). */
  baseArgs?: readonly string[];
  /** Extra flags after the built-in ones. */
  extraArgs?: readonly string[];
  env?: Record<string, string | undefined>;
}

/**
 * Runs `agy --print <prompt> --output-format stream-json` (the exact shape probed on 1.4.8) and
 * maps its NDJSON to AgentEvent. The prompt is one argv element (shell:false), as in the probe;
 * stdin input is unverified. Never passes `--mode plan` (empty result), `--sandbox`,
 * `--dangerously-skip-permissions` or `--conversation` (all unverified).
 *
 * Task permissions cannot be enforced (no verified mechanism), so a task that sets them fails
 * closed instead of running unrestricted.
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly id: string;
  private readonly running = new Map<string, RunningProcess>();

  constructor(private readonly opts: AntigravityAdapterOptions = {}) {
    this.id = opts.id ?? "agy";
  }

  async detect(): Promise<boolean> {
    try {
      resolveExecutable(this.opts.command ?? "agy", this.opts.env ? { env: this.opts.env } : {});
      return true;
    } catch {
      return false;
    }
  }

  /** Only what was observed: streamed text and structured stream-json output. */
  async capabilities(): Promise<AgentCapability[]> {
    return ["streaming", "structured_output"];
  }

  async cancel(taskId: string): Promise<void> {
    await this.running.get(taskId)?.cancel();
  }

  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    if (task.signal.aborted) {
      yield { type: "error", message: "cancelled" };
      return;
    }
    if (task.permissions !== undefined) {
      yield {
        type: "error",
        message: `agy cannot enforce task permissions "${task.permissions}" (no verified mechanism); refusing to run`,
      };
      return;
    }

    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let final: AgentEvent | undefined;
    let invalidLines = 0;
    const push = (e: AgentEvent) => {
      queue.push(e);
      wake?.();
    };

    const parser = createAntigravityParser();
    const splitter = createLineSplitter((line) => {
      if (final) return; // nothing may follow the terminal event
      if (line.trim() !== "" && !isJson(line)) invalidLines++;
      const parsed = parser.parse(line);
      for (const e of parsed.events) push(e);
      if (parsed.final) final = parsed.final;
    });

    const args = [
      ...(this.opts.baseArgs ?? []),
      "--print",
      task.prompt,
      "--output-format",
      "stream-json",
      ...(this.opts.extraArgs ?? []),
    ];
    const proc = startProcess({
      command: this.opts.command ?? "agy",
      args,
      cwd: task.cwd,
      ...(this.opts.env ? { env: this.opts.env } : {}),
      signal: task.signal,
      onStdout: (c) => splitter.write(c),
    });
    this.running.set(task.id, proc);
    void proc.done.then(() => {
      splitter.end();
      ended = true;
      wake?.();
    });

    try {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) break;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
      const result = await proc.done;
      if (task.signal.aborted && !final) {
        yield { type: "error", message: "cancelled" };
      } else if (final) {
        yield final;
      } else if (result.outcome === "spawn_error") {
        yield { type: "error", message: `could not start agy: ${result.error ?? "unknown"}` };
      } else if (result.outcome === "cancelled") {
        yield { type: "error", message: "cancelled" };
      } else {
        const detail = result.stderr.trim().slice(-300);
        yield {
          type: "error",
          message: `agy exited (code ${String(result.exitCode)}) without a result${detail ? `: ${detail}` : ""}${invalidNote(invalidLines)}`,
        };
      }
    } finally {
      this.running.delete(task.id);
      await proc.cancel();
    }
  }
}
