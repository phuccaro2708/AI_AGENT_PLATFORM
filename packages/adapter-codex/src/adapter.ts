import type { AgentCapability, AgentEvent, TaskPermissions } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import {
  createLineSplitter,
  resolveExecutable,
  startProcess,
  BASE_ENV_ALLOWLIST,
  extendManifest,
  type SpawnManifest,
  type JobWrapOptions,
  type RunningProcess,
} from "@agent-studio/process-manager";
import { createCodexParser } from "./parse.js";

/** `danger-full-access` is deliberately not offered; Codex also has a bypass flag we never pass. */
export type CodexSandbox = "read-only" | "workspace-write";

/** Task permissions win over the adapter option; with neither, stay read-only. */
export function codexSandboxFor(
  permissions: TaskPermissions | undefined,
  fallback: CodexSandbox | undefined,
): CodexSandbox {
  return permissions ?? fallback ?? "read-only";
}

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

export interface CodexAdapterOptions {
  id?: string;
  /** Executable name or path. Default `codex` (an npm shim is unwrapped to `node codex.js`). */
  command?: string;
  /** Arguments placed before `exec` (tests: the fake CLI script). */
  baseArgs?: readonly string[];
  /** Sandbox for model-generated shell commands. Default `read-only`. */
  sandbox?: CodexSandbox;
  /** Extra flags after the built-in ones. */
  extraArgs?: readonly string[];
  env?: Record<string, string | undefined>;
  /** Variable names (besides the manifest's) that the host declares on purpose: stored settings, secrets. */
  envAllow?: readonly string[];
  /** Run the CLI inside `agent-job-wrap` (P4-4 (b)): kill-on-close tree and per-process memory cap. Off by default. */
  jobWrap?: JobWrapOptions;
  /** Kill the CLI's whole process tree when its resident memory passes this many MB (P4-4 (b)). Off by default. */
  treeMemoryLimitMb?: number;
}

/**
 * What a `codex` child may be started with (P4-3): the executable `codex` and the base environment plus
 * `OPENAI_*` / `CODEX_*`. ASSUMED sufficient for a real run, NOT probed (docs/ASSUMPTIONS.md).
 */
export const CODEX_MANIFEST: SpawnManifest = {
  executables: ["codex"],
  env: BASE_ENV_ALLOWLIST,
  envPrefixes: ["OPENAI_", "CODEX_"],
};

/**
 * Runs `codex exec --json -s <sandbox> -` and maps its JSONL to AgentEvent. The prompt goes to
 * stdin (`-`), never argv or a shell string. Resume is NOT claimed: `codex exec resume` takes a
 * different argv shape that has not been verified, so `task.sessionId` is ignored for now.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id: string;
  private readonly running = new Map<string, RunningProcess>();

  private readonly manifest: SpawnManifest;

  constructor(private readonly opts: CodexAdapterOptions = {}) {
    this.id = opts.id ?? "codex";
    this.manifest = extendManifest(CODEX_MANIFEST, {
      ...(opts.command ? { executables: [opts.command] } : {}),
      ...(opts.envAllow ? { env: opts.envAllow } : {}),
    });
  }

  describeLaunch(task: AgentTask): { command: string; args: readonly string[] } {
    return { command: this.opts.command ?? "codex", args: this.buildArgs(task) };
  }

  private buildArgs(task: AgentTask): string[] {
    return [
      ...(this.opts.baseArgs ?? []),
      "exec",
      "--json",
      "-s",
      codexSandboxFor(task.permissions, this.opts.sandbox),
      ...(this.opts.extraArgs ?? []),
      "-",
    ];
  }

  async detect(): Promise<boolean> {
    try {
      resolveExecutable(this.opts.command ?? "codex", this.opts.env ? { env: this.opts.env } : {});
      return true;
    } catch {
      return false;
    }
  }

  /** Only what the help and the observed runs support; approval/resume are not claimed. */
  async capabilities(): Promise<AgentCapability[]> {
    return ["streaming", "structured_output", "tool_execution"];
  }

  async cancel(taskId: string): Promise<void> {
    await this.running.get(taskId)?.cancel();
  }

  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    if (task.signal.aborted) {
      yield { type: "error", message: "cancelled" };
      return;
    }

    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let final: AgentEvent | undefined;
    let invalidLines = 0; // non-empty stdout lines that are not JSON: reported if the run has no result
    const push = (e: AgentEvent) => {
      queue.push(e);
      wake?.();
    };

    const parser = createCodexParser();
    const splitter = createLineSplitter((line) => {
      if (final) return; // nothing may follow the terminal event
      if (line.trim() !== "" && !isJson(line)) invalidLines++;
      const parsed = parser.parse(line);
      for (const e of parsed.events) push(e);
      if (parsed.final) final = parsed.final;
    });

    const proc = startProcess({
      command: this.opts.command ?? "codex",
      args: this.buildArgs(task),
      manifest: this.manifest,
      ...(this.opts.jobWrap ? { jobWrap: this.opts.jobWrap } : {}),
      ...(this.opts.treeMemoryLimitMb === undefined
        ? {}
        : { treeMemoryLimitMb: this.opts.treeMemoryLimitMb }),
      cwd: task.cwd,
      ...(this.opts.env ? { env: this.opts.env } : {}),
      stdin: task.prompt,
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
        yield { type: "error", message: `could not start codex: ${result.error ?? "unknown"}` };
      } else if (result.outcome === "memory_limit") {
        yield {
          type: "error",
          message: `codex stopped: ${result.detail ?? "memory limit exceeded"}`,
        };
      } else if (result.outcome === "cancelled") {
        yield { type: "error", message: "cancelled" };
      } else {
        const detail = parser.lastError() ?? result.stderr.trim().slice(-300);
        yield {
          type: "error",
          message: `codex exited (code ${String(result.exitCode)}) without a result${detail ? `: ${detail}` : ""}${invalidNote(invalidLines)}`,
        };
      }
    } finally {
      this.running.delete(task.id);
      await proc.cancel(); // no-op once exited; stops the child if the consumer abandons the stream
    }
  }
}
