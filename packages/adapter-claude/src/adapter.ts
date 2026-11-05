import type { AgentCapability, AgentEvent, TaskPermissions } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import {
  BASE_ENV_ALLOWLIST,
  createLineSplitter,
  extendManifest,
  resolveExecutable,
  startProcess,
  type RunningProcess,
  type SpawnManifest,
} from "@agent-studio/process-manager";
import { parseClaudeLine } from "./parse.js";

/**
 * Flags for a task's permissions. VERIFIED (spike 2026-11-03): `--tools Read` blocks writes.
 * ASSUMED, unverified: the `Edit`/`Write` tool names and `--permission-mode acceptEdits` under `-p`
 * (docs/ASSUMPTIONS.md). No shell tool is granted either way. Advisory, not a sandbox.
 */
export function claudePermissionArgs(permissions: TaskPermissions | undefined): string[] {
  if (permissions === "read-only") return ["--tools", "Read,Grep,Glob"];
  if (permissions === "workspace-write") {
    return ["--tools", "Read,Grep,Glob,Edit,Write", "--permission-mode", "acceptEdits"];
  }
  return [];
}

/**
 * What a `claude` child may be started with (P4-3): the executable `claude` and the base environment plus
 * `ANTHROPIC_*` / `CLAUDE_*`. ASSUMED sufficient for a real login and API-key run, NOT probed (docs/ASSUMPTIONS.md);
 * anything else the user needs goes through the stored agent settings (`envAllow`).
 */
export const CLAUDE_MANIFEST: SpawnManifest = {
  executables: ["claude"],
  env: BASE_ENV_ALLOWLIST,
  envPrefixes: ["ANTHROPIC_", "CLAUDE_"],
};

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

export interface ClaudeAdapterOptions {
  id?: string;
  /** Executable name or path. Default `claude`. Tests point this at `process.execPath`. */
  command?: string;
  /** Arguments placed before the flags below (tests: the fake CLI script). */
  baseArgs?: readonly string[];
  /**
   * Pass `--safe-mode` (default true): start without the user's CLAUDE.md, hooks, plugins, skills and
   * MCP servers. Verified on 2.1.314: user SessionStart hooks otherwise run inside our task and the
   * run cost ~40x more (context bloat). It is isolation of configuration, NOT a security sandbox.
   */
  safeMode?: boolean;
  /** Extra flags, e.g. a tool allowlist (`--tools Read --allowed-tools Read`). */
  extraArgs?: readonly string[];
  env?: Record<string, string | undefined>;
  /** Variable names (besides the manifest's) that the host declares on purpose: stored settings, secrets. */
  envAllow?: readonly string[];
}

/**
 * Runs `claude -p --output-format stream-json --verbose` and maps its NDJSON to AgentEvent.
 * The prompt goes to stdin (never into argv or a shell string). VERIFIED (2.1.314, 2026-11-02): `-p` reads
 * the prompt from stdin; tool_use/tool_result shapes and `--resume` behave as mapped. See docs/ASSUMPTIONS.md.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id: string;
  private readonly running = new Map<string, RunningProcess>();
  private readonly manifest: SpawnManifest;

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {
    this.id = opts.id ?? "claude";
    // A command the host configured explicitly (a stored, probed path, or a test double) is declared too.
    this.manifest = extendManifest(CLAUDE_MANIFEST, {
      ...(opts.command ? { executables: [opts.command] } : {}),
      ...(opts.envAllow ? { env: opts.envAllow } : {}),
    });
  }

  describeLaunch(task: AgentTask): { command: string; args: readonly string[] } {
    return { command: this.opts.command ?? "claude", args: this.buildArgs(task) };
  }

  private buildArgs(task: AgentTask): string[] {
    return [
      ...(this.opts.baseArgs ?? []),
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(this.opts.safeMode === false ? [] : ["--safe-mode"]),
      ...(task.sessionId ? ["--resume", task.sessionId] : []),
      ...claudePermissionArgs(task.permissions),
      ...(this.opts.extraArgs ?? []),
    ];
  }

  async detect(): Promise<boolean> {
    try {
      resolveExecutable(this.opts.command ?? "claude", this.opts.env ? { env: this.opts.env } : {});
      return true;
    } catch {
      return false;
    }
  }

  /** Only what was observed on 2.1.314: tool use and --resume work; approval is not claimed. */
  async capabilities(): Promise<AgentCapability[]> {
    return ["streaming", "structured_output", "tool_execution", "session_resume"];
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
    const denied = new Set<string>(); // the same denial arrives twice: system/permission_denied, then the result
    const push = (e: AgentEvent) => {
      if (e.type === "permission_denied" && e.callId !== undefined) {
        if (denied.has(e.callId)) return;
        denied.add(e.callId);
      }
      queue.push(e);
      wake?.();
    };

    const splitter = createLineSplitter((line) => {
      if (final) return; // nothing may follow the terminal event
      if (line.trim() !== "" && !isJson(line)) invalidLines++;
      const parsed = parseClaudeLine(line);
      for (const e of parsed.events) push(e);
      if (parsed.final) final = parsed.final;
    });

    const proc = startProcess({
      command: this.opts.command ?? "claude",
      args: this.buildArgs(task),
      manifest: this.manifest,
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
        yield { type: "error", message: `could not start claude: ${result.error ?? "unknown"}` };
      } else if (result.outcome === "cancelled") {
        yield { type: "error", message: "cancelled" };
      } else {
        const tail = result.stderr.trim().slice(-300);
        yield {
          type: "error",
          message: `claude exited (code ${String(result.exitCode)}) without a result${tail ? `: ${tail}` : ""}${invalidNote(invalidLines)}`,
        };
      }
    } finally {
      this.running.delete(task.id);
      await proc.cancel(); // no-op once exited; stops the child if the consumer abandons the stream
    }
  }
}
