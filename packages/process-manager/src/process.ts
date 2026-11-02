import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killTree } from "./kill-tree.js";
import { UnsupportedShimError, resolveExecutable, unwrapNpmShim } from "./resolve.js";

export interface RunOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Full environment for the child. Defaults to the parent's; a Phase 4 allowlist will tighten this. */
  env?: Record<string, string | undefined>;
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

export type RunOutcome = "exited" | "timeout" | "cancelled" | "spawn_error";

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
}

export interface RunningProcess {
  pid: number | undefined;
  done: Promise<RunResult>;
  cancel(): Promise<void>;
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

  let file: string;
  let prefix: string[];
  try {
    const resolved = resolveExecutable(opts.command, {
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    const target = resolved.kind === "shim" ? unwrapNpmShim(resolved) : resolved;
    if (!target) throw new UnsupportedShimError(resolved.path);
    file = target.path;
    prefix = target.prefixArgs ?? [];
  } catch (err) {
    return failed("spawn_error", err instanceof Error ? err.message : String(err));
  }

  const posix = process.platform !== "win32";
  const child = spawn(file, [...prefix, ...(opts.args ?? [])], {
    shell: false,
    windowsHide: true,
    detached: posix, // own process group so the whole tree can be signalled
    cwd: opts.cwd,
    env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
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

  const done = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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
