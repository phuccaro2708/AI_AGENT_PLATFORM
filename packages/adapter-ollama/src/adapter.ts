import type { AgentCapability, AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter, AgentTask } from "@agent-studio/agent-core";
import { READ_ONLY_TOOLS, runReadOnlyTool } from "./tools.js";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export interface OllamaAdapterOptions {
  id?: string;
  /** Ollama server. Only a loopback address is accepted: prompts must not leave this machine by accident. */
  baseUrl?: string;
  /** Model to chat with. Without one, a task fails with a clear error (no guessing which model to load). */
  model?: string;
  /** Test seam; default is the global `fetch`. */
  fetch?: typeof fetch;
  /** `detect()` gives up after this long (default 3000 ms). */
  detectTimeoutMs?: number;
  /** A run fails when nothing arrives for this long, model load included (default 120000 ms). */
  idleTimeoutMs?: number;
  /** Ask the model to think before answering. Default false (S0: the reply was already complete without it). */
  think?: boolean;
  /** Passed as `options.num_predict` when set. */
  numPredict?: number;
  /** Passed as `keep_alive` when set (e.g. `0` unloads the model right after the reply). */
  keepAlive?: string | number;
  /**
   * `"read-only"` offers the model `list_dir` and `read_file` (confined to the task folder, see `tools.ts`) and runs
   * the loop. Off by default: the probed model answered in prose instead of calling a tool (docs/ASSUMPTIONS.md).
   */
  tools?: "read-only";
  /** Most model calls in one task when tools are on (default 4). A model that keeps asking ends in an error. */
  maxToolRounds?: number;
}

class OllamaError extends Error {}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Throws unless `url` is http(s) on a loopback host. Returns the origin (no trailing slash, no path). */
export function assertLoopbackUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid Ollama URL: ${url}`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !LOOPBACK.has(u.hostname)) {
    throw new Error(
      `Ollama URL must be http(s) on a loopback address, got ${u.protocol}//${u.hostname}`,
    );
  }
  return u.origin;
}

interface ChatChunk {
  error?: unknown;
  message?: { content?: unknown; tool_calls?: unknown };
  done?: boolean;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

interface Round {
  text: string;
  done: boolean;
  doneReason: string | undefined;
  promptTokens: number;
  evalTokens: number;
  toolCalls: RequestedTool[];
}

interface RequestedTool {
  name: string;
  args: unknown;
  /** The call as the model sent it, echoed back in the next request. */
  raw: unknown;
}

type ChatMessage = Record<string, unknown>;

/** `message.tool_calls` of a chunk, normalised. Anything that is not `{function:{name}}` is ignored. */
function readToolCalls(v: unknown): RequestedTool[] {
  if (!Array.isArray(v)) return [];
  const out: RequestedTool[] = [];
  for (const raw of v) {
    const fn = (raw as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
    if (typeof fn?.name !== "string" || fn.name === "") continue;
    let args = fn.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    out.push({ name: fn.name, args: args ?? {}, raw });
  }
  return out;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Talks to a local Ollama over HTTP (`POST /api/chat`, NDJSON stream). No process is started, so
 * `describeLaunch` is absent and the Policy Engine only checks the working directory.
 *
 * Only what S0 measured is claimed: a reply streams as text. The model is NOT assumed to call tools even if
 * `/api/tags` lists the `tools` capability (the probed model answered in prose instead).
 */
export class OllamaAdapter implements AgentAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly opts: OllamaAdapterOptions = {}) {
    this.id = opts.id ?? "ollama";
    this.baseUrl = assertLoopbackUrl(opts.baseUrl ?? DEFAULT_OLLAMA_URL);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async detect(): Promise<boolean> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.detectTimeoutMs ?? 3000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/version`, { signal: ctl.signal });
      await res.body?.cancel().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async capabilities(): Promise<AgentCapability[]> {
    return ["streaming"];
  }

  async cancel(taskId: string): Promise<void> {
    this.running.get(taskId)?.abort();
  }

  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    if (task.signal.aborted) {
      yield { type: "error", message: "cancelled" };
      return;
    }
    const model = this.opts.model;
    if (!model) {
      yield { type: "error", message: "no Ollama model is configured for this agent" };
      return;
    }

    const ctl = new AbortController();
    this.running.set(task.id, ctl);
    const onAbort = () => ctl.abort();
    task.signal.addEventListener("abort", onAbort, { once: true });
    const idleMs = this.opts.idleTimeoutMs ?? 120_000;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, idleMs);
    };

    let final: AgentEvent;
    try {
      arm();
      const toolsOn = this.opts.tools === "read-only";
      const maxRounds = this.opts.maxToolRounds ?? 4;
      const messages: ChatMessage[] = [{ role: "user", content: task.prompt }];
      let text = "";
      let promptTokens = 0;
      let completionTokens = 0;
      let round: Round;
      for (let n = 1; ; n++) {
        const body = {
          model,
          stream: true,
          think: this.opts.think ?? false,
          messages,
          ...(toolsOn ? { tools: READ_ONLY_TOOLS } : {}),
          ...(this.opts.keepAlive !== undefined ? { keep_alive: this.opts.keepAlive } : {}),
          ...(this.opts.numPredict !== undefined
            ? { options: { num_predict: this.opts.numPredict } }
            : {}),
        };
        round = yield* this.chatRound(body, ctl.signal, arm);
        text += round.text;
        promptTokens += round.promptTokens;
        completionTokens += round.evalTokens;
        // Without `tools` the model is never given a tool, so a stray `tool_calls` is ignored, not run.
        if (!toolsOn || round.toolCalls.length === 0) break;
        if (n >= maxRounds) {
          throw new OllamaError(
            `the model was still asking for tools after ${String(maxRounds)} rounds`,
          );
        }
        messages.push({
          role: "assistant",
          content: round.text,
          tool_calls: round.toolCalls.map((c) => c.raw),
        });
        for (const [i, call] of round.toolCalls.entries()) {
          const callId = `${task.id}-${String(n)}-${String(i)}`;
          yield { type: "tool_call", name: call.name, args: call.args, callId };
          // Whitelist and confinement live in runReadOnlyTool; a refused call is told to the model, not run.
          const out = runReadOnlyTool(call.name, call.args, task.cwd);
          yield {
            type: "tool_result",
            result: out.ok ? out.content : { error: out.content },
            callId,
          };
          messages.push({
            role: "tool",
            tool_name: call.name,
            content: out.ok ? out.content : `error: ${out.content}`,
          });
        }
      }
      if (round.doneReason === "length") {
        final = {
          type: "error",
          message: "the model stopped at its token limit; the reply is cut off",
        };
      } else if (text.trim() === "") {
        final = {
          type: "error",
          message: `the model returned an empty reply (done_reason ${round.doneReason ?? "none"})`,
        };
      } else {
        yield { type: "usage", data: { promptTokens, completionTokens } };
        final = { type: "completed" };
      }
    } catch (err) {
      // `cancel(taskId)` aborts `ctl` without touching the task's own signal, so look at both.
      if (task.signal.aborted || (ctl.signal.aborted && !timedOut)) {
        final = { type: "error", message: "cancelled" };
      } else if (timedOut) {
        final = { type: "error", message: `Ollama sent nothing for ${String(idleMs / 1000)} s` };
      } else final = { type: "error", message: this.describeError(err) };
    } finally {
      if (timer) clearTimeout(timer);
      task.signal.removeEventListener("abort", onAbort);
      this.running.delete(task.id);
    }
    yield final;
  }

  private describeError(err: unknown): string {
    if (err instanceof OllamaError) return err.message;
    const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    return `Ollama is not reachable at ${this.baseUrl}${typeof cause === "string" ? ` (${cause})` : ""}`;
  }

  /** One `/api/chat` call: yields text as it arrives, returns what the final chunk reported. */
  private async *chatRound(
    body: unknown,
    signal: AbortSignal,
    onActivity: () => void,
  ): AsyncGenerator<AgentEvent, Round> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text) as { error?: unknown };
        if (typeof j.error === "string") detail = j.error.slice(0, 200);
      } catch {
        // not JSON: keep the raw start
      }
      throw new OllamaError(`Ollama answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }

    const round: Round = {
      text: "",
      done: false,
      doneReason: undefined,
      promptTokens: 0,
      evalTokens: 0,
      toolCalls: [],
    };
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let pending = "";
    const handle = (line: string): AgentEvent | undefined => {
      if (line.trim() === "") return undefined;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(line) as ChatChunk;
      } catch {
        throw new OllamaError("Ollama sent a line that is not JSON");
      }
      if (chunk.error !== undefined) {
        throw new OllamaError(`Ollama error: ${String(chunk.error).slice(0, 200)}`);
      }
      if (chunk.done === true) {
        round.done = true;
        round.doneReason = typeof chunk.done_reason === "string" ? chunk.done_reason : undefined;
        round.promptTokens = num(chunk.prompt_eval_count);
        round.evalTokens = num(chunk.eval_count);
      }
      round.toolCalls.push(...readToolCalls(chunk.message?.tool_calls));
      const content = chunk.message?.content;
      if (typeof content === "string" && content !== "") {
        round.text += content;
        return { type: "text", content };
      }
      return undefined;
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity();
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const ev = handle(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        if (ev) yield ev;
      }
    }
    pending += decoder.decode();
    const last = handle(pending);
    if (last) yield last;
    if (!round.done) throw new OllamaError("Ollama ended the stream without a final `done` chunk");
    return round;
  }
}
