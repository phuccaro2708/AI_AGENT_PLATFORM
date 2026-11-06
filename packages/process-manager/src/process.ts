import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { killTree } from "./kill-tree.js";
import { assertExecutableAllowed, filterEnv, type SpawnManifest } from "./manifest.js";
import { sampleTreeBytes, type TreeMemorySampler } from "./tree-memory.js";
import { UnsupportedShimError, resolveExecutable, unwrapNpmShim } from "./resolve.js";

/**
 * P4-4 (b): run the child inside `agent-job-wrap` (a Windows Job Object with kill-on-close). The wrapper is
 * started as `<path> [--mem-limit-mb N] [--timeout-secs N] -- <resolved program> <args…>`; the manifest check
 * and executable resolution still apply to the CLI, not to the wrapper. Lifetime and per-process memory only; not a sandbox.
 */
export interface JobWrapOptions {
  /** Absolute path of the `agent-job-wrap` binary. A relative or missing path is a `spawn_error` (fail closed). */
  path: string;
  /** `--mem-limit-mb`: commit cap of EACH process in the job (not the tree total). Positive integer. */
  memLimitMb?: number;
  /** `--timeout-secs`: the wrapper kills the tree and exits 124 after this long. Positive integer. */
  timeoutSecs?: number;
}

export interface RunOptions {
  command: string;
  /** Run the resolved program through `agent-job-wrap` (see `JobWrapOptions`). */
  jobWrap?: JobWrapOptions;
  /**
   * Kill the whole process tree (outcome `memory_limit`) when its resident memory exceeds this many MB.
   * Sampled every `memoryPollMs` (default 1000), so it is a watchdog and not a hard cap. Positive integer.
   */
  treeMemoryLimitMb?: number;
  memoryPollMs?: number;
  /** Replaces the real sampler (tests). */
  memorySampler?: TreeMemorySampler;
  args?: readonly string[];
  cwd?: string;
  /** Full environment for the child. Defaults to the parent's; with a `manifest` only declared names get through. */
  env?: Record<string, string | undefined>;
  /**
   * Adapter allowlist (P4-3). When set, `command` must be a declared executable and the child sees only the
   * declared environment variables. Optional because `cli-probe` and `git-worktrees` spawn through here too.
   */
  manifest?: SpawnManifest;
  /** Text written to stdin, then stdin is closed. Default: stdin is ignored. */
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Max characters kept in `RunResult.stdout/stderr` (each). Default 1 MiB. Streaming callbacks are not limited. */
  maxCapture?: number;
  /** After the process exits, how long to wait for stdio to close before destroying streams. Default 1000. */
  stdioCloseGraceMs?: number;
}

export type RunOutcome = "exited" | "timeout" | "cancelled" | "spawn_error" | "memory_limit";

export interface RunResult {
  outcome: RunOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid: number | undefined;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
  /** Why the run was ended by the host (`memory_limit`: measured size and limit). */
  detail?: string;
}

export interface RunningProcess {
  pid: number | undefined;
  done: Promise<RunResult>;
  cancel(): Promise<void>;
}

const MAX_SAMPLE_FAILURES = 5;

/** Validates the wrapper settings and returns its leading flags. Throws, so the caller reports `spawn_error`. */
export function jobWrapArgs(w: JobWrapOptions): string[] {
  if (!isAbsolute(w.path) || !existsSync(w.path)) {
    throw new Error("agent-job-wrap: path must be an existing absolute path");
  }
  const flags: string[] = [];
  for (const [flag, n] of [
    ["--mem-limit-mb", w.memLimitMb],
    ["--timeout-secs", w.timeoutSecs],
  ] as const) {
    if (n === undefined) continue;
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(`agent-job-wrap: ${flag} must be a positive integer`);
    flags.push(flag, String(n));
  }
  return flags;
}

/**
 * Starts a child process with an argument array and `shell:false`.
 * Resolution failures and Windows shims are reported as `spawn_error`, never thrown.
 */
export function startProcess(opts: RunOptions): RunningProcess {
  const empty = (outcome: RunOutcome, error?: string): RunResult => ({
    outcome,
    exitCode: null,
    signal: null,
    pid: undefined,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...(error === undefined ? {} : { error }),
  });
  const failed = (outcome: RunOutcome, error?: string): RunningProcess => ({
    pid: undefined,
    done: Promise.resolve(empty(outcome, error)),
    cancel: () => Promise.resolve(),
  });

  if (opts.signal?.aborted) return failed("cancelled");

  // The single enforcement point of the adapter manifest (P4-3): checked before anything is resolved or spawned.
  let env: Record<string, string | undefined> | undefined = opts.env;
  if (opts.manifest) {
    try {
      assertExecutableAllowed(opts.manifest, opts.command);
    } catch (err) {
      return failed("spawn_error", err instanceof Error ? err.message : String(err));
    }
    env = filterEnv(opts.manifest, opts.env ?? process.env);
  }

  let file: string;
  let prefix: string[];
  try {
    const resolved = resolveExecutable(opts.command, {
      ...(env ? { env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    const target = resolved.kind === "shim" ? unwrapNpmShim(resolved) : resolved;
    if (!target) throw new UnsupportedShimError(resolved.path);
    file = target.path;
    prefix = target.prefixArgs ?? [];
  } catch (err) {
    return failed("spawn_error", err instanceof Error ? err.message : String(err));
  }

  const mem = opts.treeMemoryLimitMb;
  if (mem !== undefined && (!Number.isInteger(mem) || mem <= 0)) {
    return failed("spawn_error", "treeMemoryLimitMb must be a positive integer");
  }

  let spawnFile = file;
  let spawnArgs: string[] = [...prefix, ...(opts.args ?? [])];
  if (opts.jobWrap) {
    try {
      spawnArgs = [...jobWrapArgs(opts.jobWrap), "--", file, ...spawnArgs];
      spawnFile = opts.jobWrap.path;
    } catch (err) {
      return failed("spawn_error", err instanceof Error ? err.message : String(err));
    }
  }

  const posix = process.platform !== "win32";
  const child = spawn(spawnFile, spawnArgs, {
    shell: false,
    windowsHide: true,
    detached: posix, // own process group so the whole tree can be signalled
    cwd: opts.cwd,
    env: (env ?? process.env) as NodeJS.ProcessEnv,
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

  const max = opts.maxCapture ?? 1024 * 1024;
  let out = "";
  let err = "";
  let outTrunc = false;
  let errTrunc = false;
  const outDec = new StringDecoder("utf8");
  const errDec = new StringDecoder("utf8");
  const take = (cur: string, add: string): [string, boolean] =>
    cur.length + add.length <= max ? [cur + add, false] : [(cur + add).slice(0, max), true];

  child.stdout?.on("data", (b: Buffer) => {
    const s = outDec.write(b);
    [out, outTrunc] = outTrunc ? [out, true] : take(out, s);
    opts.onStdout?.(s);
  });
  child.stderr?.on("data", (b: Buffer) => {
    const s = errDec.write(b);
    [err, errTrunc] = errTrunc ? [err, true] : take(err, s);
    opts.onStderr?.(s);
  });

  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => undefined); // EPIPE if the child exits early
    child.stdin.end(opts.stdin);
  }

  let outcome: RunOutcome = "exited";
  let killing: Promise<void> | undefined;
  const terminate = (why: RunOutcome): Promise<void> => {
    if (killing) return killing;
    outcome = why;
    killing = child.pid === undefined ? Promise.resolve() : killTree(child.pid);
    return killing;
  };

  const timer =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => void terminate("timeout"), opts.timeoutMs);
  const onAbort = () => void terminate("cancelled");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  // P4-4 (b): RAM of the whole tree. Polling, so a fast allocator can overshoot before it is killed.
  let detail: string | undefined;
  let stopWatch: (() => void) | undefined;
  if (opts.treeMemoryLimitMb !== undefined && child.pid !== undefined) {
    const limit = opts.treeMemoryLimitMb * 1024 * 1024;
    const sample = opts.memorySampler ?? sampleTreeBytes;
    const rootPid = child.pid;
    let busy = false;
    let failures = 0;
    const tick = async (): Promise<void> => {
      if (busy || killing) return;
      busy = true;
      try {
        const bytes = await sample(rootPid);
        failures = 0;
        if (bytes > limit) {
          detail = `process tree uses ${Math.round(bytes / 1048576)} MB, limit ${opts.treeMemoryLimitMb} MB`;
          void terminate("memory_limit");
        }
      } catch {
        // Cannot measure: after MAX_SAMPLE_FAILURES in a row the limit is treated as exceeded (fail closed).
        if (++failures >= MAX_SAMPLE_FAILURES) {
          detail = "cannot measure the memory of the process tree";
          void terminate("memory_limit");
        }
      } finally {
        busy = false;
      }
    };
    const interval = setInterval(() => void tick(), opts.memoryPollMs ?? 1000);
    interval.unref();
    stopWatch = () => clearInterval(interval);
  }

  const done = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stopWatch?.();
      opts.signal?.removeEventListener("abort", onAbort);
      const tailOut = outDec.end();
      const tailErr = errDec.end();
      if (tailOut) opts.onStdout?.(tailOut);
      if (tailErr) opts.onStderr?.(tailErr);
      resolve({
        outcome: error !== undefined ? "spawn_error" : outcome,
        exitCode,
        signal,
        pid: child.pid,
        stdout: out + tailOut,
        stderr: err + tailErr,
        stdoutTruncated: outTrunc,
        stderrTruncated: errTrunc,
        ...(error === undefined ? {} : { error }),
        ...(detail === undefined ? {} : { detail }),
      });
    };
    child.on("error", (e) => finish(null, null, e.message));
    child.on("exit", (code, signal) => {
      // A surviving grandchild can keep the pipes open; do not wait for it forever.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, opts.stdioCloseGraceMs ?? 1000).unref();
      child.on("close", () => finish(code, signal));
    });
  });

  return { pid: child.pid, done, cancel: () => terminate("cancelled") };
}

export function runProcess(opts: RunOptions): Promise<RunResult> {
  return startProcess(opts).done;
}
