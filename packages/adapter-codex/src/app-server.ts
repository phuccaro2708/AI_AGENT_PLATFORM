import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentCapability, AgentEvent, TaskPermissions } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import {
  assertExecutableAllowed,
  createLineSplitter,
  extendManifest,
  filterEnv,
  jobWrapArgs,
  killTree,
  resolveExecutable,
  unwrapNpmShim,
  sampleTreeBytes,
  trackLivePid,
  type JobWrapOptions,
  type SpawnManifest,
  type TreeMemorySampler,
} from "@agent-studio/process-manager";
import { CODEX_MANIFEST, codexSandboxFor, type CodexSandbox } from "./adapter.js";

/**
 * What the adapter puts to the Policy Engine. Same shape as the `PolicyRequest` kinds it uses; declared here so
 * adapter-codex needs no dependency on policy-engine (the host injects `evaluate`).
 */
export type AppServerGateRequest =
  | { kind: "command"; executable: string; args: readonly string[] }
  | { kind: "fs.write"; path: string };

/** The part of the engine's `Decision` this adapter reads. `ask` is treated as decline: nobody is in this loop. */
export interface AppServerGateDecision {
  effect: "allow" | "ask" | "deny";
  code: string;
  reason: string;
}

/** What the host needs to build a policy for this task (level from permissions, workspace root from cwd). */
export interface AppServerGateContext {
  taskId: string;
  cwd: string;
  permissions: TaskPermissions | undefined;
}

export interface CodexAppServerOptions {
  id?: string;
  /** Executable name or path. Default `codex` (an npm shim is unwrapped to `node codex.js`, `shell:false`). */
  command?: string;
  /** Arguments placed before `app-server` (tests: the fake server script). */
  baseArgs?: readonly string[];
  /** Sandbox when the task names none. Default `read-only`. `danger-full-access` is never offered. */
  sandbox?: CodexSandbox;
  env?: Record<string, string | undefined>;
  envAllow?: readonly string[];
  /**
   * The Policy Engine entry point (`evaluate` with a policy built from the context). REQUIRED: without a gate this
   * path would not exist. A throw, a rejection or a timeout is a decline.
   */
  evaluate: (
    request: AppServerGateRequest,
    ctx: AppServerGateContext,
  ) => Promise<AppServerGateDecision>;
  /** How long one approval may take before it is declined (never retried). Default 60 000 ms. */
  approvalTimeoutMs?: number;
  /**
   * Start the server inside `agent-job-wrap` (kill-on-close Job Object, optional whole-tree commit cap), like the
   * `codex exec` adapter. The wrapper inherits stdio, so the JSON-RPC pipe is unchanged. A bad path fails the task
   * closed (`could not start codex`). Not a sandbox.
   */
  jobWrap?: JobWrapOptions;
  /**
   * Whole-tree RAM watchdog in MB (opt-in, same semantics as `startProcess`): it polls the resident memory of the
   * server's process tree and kills the tree when it passes the limit; the task then ends with an error that needs
   * reconciliation if the turn had started. A watchdog, not a hard cap. Positive integer.
   */
  treeMemoryLimitMb?: number;
  memoryPollMs?: number;
  /** Tests only. */
  memorySampler?: TreeMemorySampler;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// A server request we do not handle gets this, so the turn cannot hang on a reply that never comes.
const METHOD_NOT_FOUND = -32601;

/** Anything a shell would interpret. A command containing one is declined, never "unwrapped". */
const SHELL_SYNTAX = /["'`$&|;<>()\\^%*?[\]{}~!#\r\n\0]/;

/**
 * Splits `codex`'s command string into program + arguments only when that is unambiguous (plain words separated
 * by spaces). Quotes, escapes, redirects, globs or substitutions → `undefined` (decline). The Windows shape
 * `"…\pwsh.exe" -Command '…'` therefore never reaches the engine as an allowed command.
 */
export function splitPlainCommand(
  command: string,
): { executable: string; args: string[] } | undefined {
  if (SHELL_SYNTAX.test(command)) return undefined;
  const words = command.split(/\s+/).filter((w) => w !== "");
  const [executable, ...args] = words;
  return executable === undefined ? undefined : { executable, args };
}

/**
 * The ONE wrapper seen from the real CLI on Windows (docs/ASSUMPTIONS.md c2/c3):
 * `"<path>\pwsh.exe" -Command '<inner>'` — double-quoted executable path, exactly `-Command`, one single-quoted
 * argument and nothing after it. Second observed form (codex-cli 0.166.0, ASSUMPTIONS d6): a command that is ONE word
 * comes WITHOUT quotes (`-Command Get-ChildItem`); only `[A-Za-z0-9_.-]+` is taken in that form. Any other shape (other flags, `-EncodedCommand`, double-quoted inner, `''`
 * escapes, another host) returns `undefined` and is declined. This only strips the wrapper; the inner text still has to
 * pass `splitPlainCommand` and the Policy Engine, and nothing is ever evaluated or re-joined into a shell string.
 */
const PWSH_WRAPPER = /^"([^"]*)" -Command (?:'([^']*)'|([A-Za-z0-9_.-]+))$/;
export function unwrapPowerShellCommand(command: string): string | undefined {
  const m = PWSH_WRAPPER.exec(command);
  if (!m) return undefined;
  const host = (m[1] ?? "").split(/[\\/]/).pop()?.toLowerCase();
  const inner = (m[2] ?? m[3] ?? "").trim();
  return host === "pwsh.exe" && inner !== "" ? inner : undefined;
}

/**
 * PowerShell commands that run text or other programs. Refused here even if a policy rule would list them: allowing
 * one makes every other rule meaningless (the engine's interpreter list does not know PowerShell cmdlets).
 */
const POWERSHELL_EXEC = new Set([
  "invoke-expression",
  "iex",
  "invoke-command",
  "icm",
  "start-process",
  "saps",
  "start",
  "invoke-item",
  "ii",
  "add-type",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "cmd",
  "cmd.exe",
]);

interface Verdict {
  accept: boolean;
  reason: string;
  /** Goes into the `permission_denied` event so the audit shows what was refused. */
  input?: unknown;
  toolName: string;
}

/**
 * Runs `codex app-server --stdio` (JSON-RPC lines, no "jsonrpc" field) and answers its approval requests through
 * the Policy Engine. Protocol facts come from docs/ASSUMPTIONS.md (c2); the protocol is experimental.
 *
 *  - Every thread starts with `approvalPolicy:"untrusted"` and a `read-only`/`workspace-write` sandbox; the
 *    bypass and `danger-full-access` modes are never sent.
 *  - The only answers sent are `accept` and `decline`. `acceptForSession`, execpolicy amendments and a `grantRoot`
 *    wider than the request are never granted: an approval must not widen what the sandbox allows.
 *  - Fail-closed: `ask`, `deny`, an engine error, a timeout, an unknown thread or a missing file list = `decline`.
 *  - The run ends at `turn/completed` (the server is long-lived), then the process is killed. If the connection is
 *    lost after `turn/start` the error carries `needsReconciliation` and nothing is retried.
 */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly id: string;
  private readonly manifest: SpawnManifest;
  private readonly running = new Map<string, () => Promise<void>>();

  constructor(private readonly opts: CodexAppServerOptions) {
    this.id = opts.id ?? "codex-app-server";
    this.manifest = extendManifest(CODEX_MANIFEST, {
      ...(opts.command ? { executables: [opts.command] } : {}),
      ...(opts.envAllow ? { env: opts.envAllow } : {}),
    });
  }

  describeLaunch(_task?: AgentTask): { command: string; args: readonly string[] } {
    return {
      command: this.opts.command ?? "codex",
      args: [...(this.opts.baseArgs ?? []), "app-server", "--stdio"],
    };
  }

  async detect(): Promise<boolean> {
    try {
      resolveExecutable(this.opts.command ?? "codex", this.opts.env ? { env: this.opts.env } : {});
      return true;
    } catch {
      return false;
    }
  }

  /** "approval" is claimed because this class answers approval requests (tested against a fake server only). */
  async capabilities(): Promise<AgentCapability[]> {
    return ["streaming", "tool_execution", "approval"];
  }

  async cancel(taskId: string): Promise<void> {
    await this.running.get(taskId)?.();
  }

  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    if (task.signal.aborted) {
      yield { type: "error", message: "cancelled" };
      return;
    }

    let child: ChildProcess;
    try {
      assertExecutableAllowed(this.manifest, this.opts.command ?? "codex");
      const env = filterEnv(this.manifest, this.opts.env ?? process.env);
      const resolved = resolveExecutable(this.opts.command ?? "codex", { env, cwd: task.cwd });
      const target = resolved.kind === "shim" ? unwrapNpmShim(resolved) : resolved;
      if (!target) throw new Error(`unsupported launcher: ${resolved.path}`);
      const launch = this.describeLaunch();
      const program = [target.path, ...(target.prefixArgs ?? []), ...launch.args];
      const wrapped = this.opts.jobWrap
        ? {
            file: this.opts.jobWrap.path,
            args: [...jobWrapArgs(this.opts.jobWrap), "--", ...program],
          }
        : { file: program[0]!, args: program.slice(1) };
      child = spawn(wrapped.file, wrapped.args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        cwd: task.cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      yield {
        type: "error",
        message: `could not start codex: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    // ---- state shared by the stream handlers -----------------------------------------------------------------
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const push = (e: AgentEvent) => {
      queue.push(e);
      wake?.();
    };
    let closed = false;
    let spawnError: string | undefined;
    let turnSent = false;
    let threadId: string | undefined;
    let final: AgentEvent | undefined;
    let stderrTail = "";
    const fileItems = new Map<string, string[]>();
    const waiters = new Map<number | string, (m: Json) => void>();
    let nextId = 1;

    const write = (o: Json) => {
      if (closed) return;
      child.stdin?.write(`${JSON.stringify(o)}\n`);
    };
    child.stdin?.on("error", () => undefined); // EPIPE once the server is gone

    const kill = async () => {
      if (child.pid !== undefined && !closed) await killTree(child.pid);
    };
    this.running.set(task.id, kill);
    let memoryDetail: string | undefined;
    let stopWatch: (() => void) | undefined;
    const memMb = this.opts.treeMemoryLimitMb;
    if (memMb !== undefined && child.pid !== undefined) {
      if (!Number.isInteger(memMb) || memMb <= 0) {
        memoryDetail = "treeMemoryLimitMb must be a positive integer";
        void kill();
      } else {
        const rootPid = child.pid;
        const sample = this.opts.memorySampler ?? sampleTreeBytes;
        let busy = false;
        let failures = 0;
        const tick = async (): Promise<void> => {
          if (busy || closed || memoryDetail !== undefined) return;
          busy = true;
          try {
            const bytes = await sample(rootPid);
            failures = 0;
            if (bytes > memMb * 1024 * 1024) {
              memoryDetail = `process tree uses ${Math.round(bytes / 1048576)} MB, limit ${memMb} MB`;
              await kill();
            }
          } catch {
            if (++failures >= 5) {
              memoryDetail = "cannot measure the memory of the process tree";
              await kill(); // fail closed, like startProcess
            }
          } finally {
            busy = false;
          }
        };
        const interval = setInterval(() => void tick(), this.opts.memoryPollMs ?? 1000);
        interval.unref();
        stopWatch = () => clearInterval(interval);
      }
    }
    const onAbort = () => void kill();
    task.signal.addEventListener("abort", onAbort, { once: true });

    const request = (method: string, params: Json): Promise<Json> =>
      new Promise((res, rej) => {
        const id = nextId++;
        waiters.set(id, (m) => {
          const error = obj(m["error"]);
          if (error) rej(new Error(`${method}: ${str(error["message"]) ?? "error response"}`));
          else res(obj(m["result"]) ?? {});
        });
        write({ id, method, params });
      });

    // ---- approval requests ----------------------------------------------------------------------------------
    const ctx: AppServerGateContext = {
      taskId: task.id,
      cwd: task.cwd,
      permissions: task.permissions,
    };
    const timeoutMs = this.opts.approvalTimeoutMs ?? 60_000;

    const gate = async (req: AppServerGateRequest): Promise<AppServerGateDecision> => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<AppServerGateDecision>((res) => {
        timer = setTimeout(
          () =>
            res({
              effect: "deny",
              code: "timeout",
              reason: `no decision within ${timeoutMs} ms; declined, not retried`,
            }),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([this.opts.evaluate(req, ctx), deadline]);
      } catch {
        return { effect: "deny", code: "internal_error", reason: "policy check failed; declined" };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const fromDecision = (d: AppServerGateDecision): { accept: boolean; reason: string } =>
      d.effect === "allow"
        ? { accept: true, reason: d.reason }
        : {
            accept: false,
            reason:
              d.effect === "ask"
                ? `needs a person's approval (${d.code}): ${d.reason}`
                : `policy denied (${d.code}): ${d.reason}`,
          };

    const decide = async (method: string, params: Json): Promise<Verdict> => {
      const itemId = str(params["itemId"]);
      if (method === "item/commandExecution/requestApproval") {
        const base = { toolName: "command", input: { command: params["command"] } };
        if (params["threadId"] !== threadId) {
          return { ...base, accept: false, reason: "request belongs to another thread" };
        }
        const command = str(params["command"]);
        const inner =
          command === undefined ? undefined : (unwrapPowerShellCommand(command) ?? command);
        const parts = inner === undefined ? undefined : splitPlainCommand(inner);
        if (!parts) {
          return {
            ...base,
            accept: false,
            reason: "command is not a plain program + arguments (shell syntax or a shell wrapper)",
          };
        }
        if (POWERSHELL_EXEC.has(parts.executable.toLowerCase())) {
          return {
            ...base,
            accept: false,
            reason: "command runs other code (interpreter, Invoke-Expression, Start-Process…)",
          };
        }
        return {
          ...base,
          ...fromDecision(
            await gate({ kind: "command", executable: parts.executable, args: parts.args }),
          ),
        };
      }

      // item/fileChange/requestApproval: the request carries no paths; they come from the item seen earlier.
      const base = { toolName: "file_change" };
      if (params["threadId"] !== threadId) {
        return { ...base, accept: false, reason: "request belongs to another thread" };
      }
      if (params["grantRoot"] !== null && params["grantRoot"] !== undefined) {
        return {
          ...base,
          accept: false,
          reason: "grantRoot would widen the writable area; declined",
        };
      }
      const paths = itemId === undefined ? undefined : fileItems.get(itemId);
      if (!paths || paths.length === 0) {
        return { ...base, accept: false, reason: "no file list seen for this change; declined" };
      }
      for (const p of paths) {
        const absolute = isAbsolute(p) ? p : resolve(task.cwd, p);
        const verdict = fromDecision(await gate({ kind: "fs.write", path: absolute }));
        if (!verdict.accept) return { ...base, ...verdict, input: { path: absolute } };
      }
      return { ...base, accept: true, reason: "every path allowed", input: { paths } };
    };

    const answerServerRequest = async (id: number | string, method: string, params: Json) => {
      if (
        method !== "item/commandExecution/requestApproval" &&
        method !== "item/fileChange/requestApproval"
      ) {
        write({ id, error: { code: METHOD_NOT_FOUND, message: `unsupported request: ${method}` } });
        return;
      }
      let verdict: Verdict;
      try {
        verdict = await decide(method, params);
      } catch {
        verdict = {
          toolName: "approval",
          accept: false,
          reason: "approval handling failed; declined",
        };
      }
      if (!verdict.accept) {
        const itemId = str(params["itemId"]);
        push({
          type: "permission_denied",
          toolName: verdict.toolName,
          ...(itemId ? { callId: itemId } : {}),
          ...(verdict.input === undefined ? {} : { input: verdict.input }),
          reason: verdict.reason,
        });
      }
      write({ id, result: { decision: verdict.accept ? "accept" : "decline" } });
    };

    // ---- incoming lines ---------------------------------------------------------------------------------------
    const onItem = (started: boolean, item: Json) => {
      const id = str(item["id"]);
      if (item["type"] === "fileChange") {
        const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
        const paths = changes.map((c) => str(obj(c)?.["path"])).filter((p): p is string => !!p);
        if (id && paths.length > 0) fileItems.set(id, paths);
        const name = "file_change";
        push(
          started
            ? { type: "tool_call", name, args: { paths }, ...(id ? { callId: id } : {}) }
            : {
                type: "tool_result",
                result: { status: item["status"] },
                ...(id ? { callId: id } : {}),
              },
        );
      } else if (item["type"] === "commandExecution") {
        push(
          started
            ? {
                type: "tool_call",
                name: "command_execution",
                args: { command: item["command"] },
                ...(id ? { callId: id } : {}),
              }
            : {
                type: "tool_result",
                result: { status: item["status"], exitCode: item["exitCode"] },
                ...(id ? { callId: id } : {}),
              },
        );
      } else if (!started && item["type"] === "agentMessage") {
        const text = str(item["text"]);
        if (text) push({ type: "text", content: text });
      }
    };

    const onLine = (line: string) => {
      if (final || line.trim() === "") return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const m = obj(raw);
      if (!m) return;
      const id = m["id"];
      const idOk = typeof id === "number" || typeof id === "string";
      const method = str(m["method"]);
      if (method !== undefined && idOk) {
        void answerServerRequest(id, method, obj(m["params"]) ?? {});
      } else if (method === undefined && idOk) {
        waiters.get(id)?.(m);
        waiters.delete(id);
      } else if (method === "item/started" || method === "item/completed") {
        const item = obj(obj(m["params"])?.["item"]);
        if (item) onItem(method === "item/started", item);
      } else if (method === "turn/completed") {
        const status = str(obj(obj(m["params"])?.["turn"])?.["status"]);
        final =
          status === "completed"
            ? { type: "completed", ...(threadId ? { sessionId: threadId } : {}) }
            : { type: "error", message: `codex turn ended with status ${status ?? "unknown"}` };
        wake?.();
      }
    };

    const splitter = createLineSplitter(onLine);
    child.stdout?.on("data", (b: Buffer) => splitter.write(b));
    const errDecoder = new StringDecoder("utf8");
    child.stderr?.on("data", (b: Buffer) => {
      stderrTail = (stderrTail + errDecoder.write(b)).slice(-300);
    });
    child.on("error", (e) => {
      spawnError = e.message;
    });
    const untrack = child.pid === undefined ? undefined : trackLivePid(child.pid);
    child.on("close", () => {
      untrack?.();
      splitter.end();
      closed = true;
      for (const w of waiters.values()) w({ error: { message: "connection closed" } });
      waiters.clear();
      wake?.();
    });

    // ---- the handshake, concurrently with the event loop ----------------------------------------------------
    const drive = async () => {
      await request("initialize", {
        clientInfo: { name: "agent-studio", title: "Agent Studio", version: "0.0.0" },
      });
      write({ method: "initialized" });
      const started = await request("thread/start", {
        cwd: task.cwd,
        sandbox: codexSandboxFor(task.permissions, this.opts.sandbox),
        approvalPolicy: "untrusted",
        ephemeral: true,
      });
      threadId = str(obj(started["thread"])?.["id"]);
      if (!threadId) throw new Error("thread/start returned no thread id");
      turnSent = true;
      await request("turn/start", {
        threadId,
        input: [{ type: "text", text: task.prompt }],
      });
    };
    let driveError: string | undefined;
    void drive().catch((e: unknown) => {
      driveError = e instanceof Error ? e.message : String(e);
      wake?.();
    });

    try {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (final || closed || driveError !== undefined) break;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
      while (queue.length) yield queue.shift() as AgentEvent; // events that arrived with the terminal line

      if (memoryDetail !== undefined) {
        yield {
          type: "error",
          message: `codex stopped: ${memoryDetail}${turnSent ? "; side effects unverified" : ""}`,
          ...(turnSent ? { needsReconciliation: true } : {}),
        };
      } else if (final) {
        yield final;
      } else if (task.signal.aborted) {
        yield { type: "error", message: "cancelled" };
      } else if (spawnError !== undefined) {
        yield { type: "error", message: `could not start codex: ${spawnError}` };
      } else if (turnSent) {
        // The turn may have changed things before the connection went away: a person must look, no retry.
        const tail = stderrTail.trim();
        yield {
          type: "error",
          message: `codex app-server lost after turn/start${driveError ? ` (${driveError})` : ""}${tail ? `: ${tail}` : ""}; side effects unverified`,
          needsReconciliation: true,
        };
      } else {
        const tail = stderrTail.trim();
        yield {
          type: "error",
          message: `codex app-server failed before the turn started${driveError ? `: ${driveError}` : ""}${tail ? `: ${tail}` : ""}`,
        };
      }
    } finally {
      stopWatch?.();
      task.signal.removeEventListener("abort", onAbort);
      this.running.delete(task.id);
      await kill(); // the server is long-lived: it never exits on its own after the turn
    }
  }
}
