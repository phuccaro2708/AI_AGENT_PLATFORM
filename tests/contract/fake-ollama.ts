import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal stand-in for the Ollama HTTP API (loopback, random port). Shapes follow what S0 measured on
 * Ollama 0.40.14: `/api/version`, NDJSON `/api/chat` chunks with `message.content`, a final `done:true`
 * chunk with `done_reason`, `prompt_eval_count`, `eval_count`, and `{"error": "..."}` for failures.
 */
export type FakeMode =
  | "ok"
  | "multi-chunk-split" // one JSON line split across two TCP writes
  | "empty"
  | "length"
  | "no-done"
  | "garbage"
  | "error-line"
  | "http-500"
  | "model-missing" // 404 with a JSON error, as Ollama answers for an unpulled model
  | "hang" // sends headers and one chunk, then nothing
  | "scripted"; // one `ScriptStep` per /api/chat request, in order (the last one repeats)

/** What a scripted reply contains: some text and/or tool calls (`function.arguments` as an object, as Ollama sends). */
export interface ScriptStep {
  text?: string;
  toolCalls?: { name: string; arguments: unknown }[];
}

export interface FakeOllama {
  url: string;
  mode: FakeMode;
  /** Parsed bodies of the `/api/chat` requests, in order. */
  chats: Record<string, unknown>[];
  script: ScriptStep[];
  /** Body of `GET /api/ps`; `undefined` answers HTTP 500. Default: one partly-loaded model, as measured in S0. */
  ps: unknown;
  close(): Promise<void>;
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const chunk = (content: string) => line({ model: "m", message: { role: "assistant", content } });
const doneChunk = (reason = "stop") =>
  line({
    model: "m",
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: reason,
    prompt_eval_count: 12,
    eval_count: 3,
  });

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += String(c);
  return s;
}

export async function startFakeOllama(mode: FakeMode = "ok"): Promise<FakeOllama> {
  const state: FakeOllama = {
    url: "",
    mode,
    chats: [],
    script: [],
    ps: {
      models: [
        { name: "m:latest", size: 9_400_000_000, size_vram: 6_000_000_000, context_length: 4096 },
      ],
    },
    close: () => new Promise((res) => server.close(() => res())),
  };
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url === "/api/version") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ version: "0.40.14" }));
        return;
      }
      if (req.url === "/api/ps") {
        if (state.ps === undefined) {
          res.statusCode = 500;
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(state.ps));
        return;
      }
      if (req.url !== "/api/chat" || req.method !== "POST") {
        res.statusCode = 404;
        res.end();
        return;
      }
      state.chats.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      const m = state.mode;
      if (m === "http-500") {
        res.statusCode = 500;
        res.end("internal boom");
        return;
      }
      if (m === "model-missing") {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "model 'nope' not found" }));
        return;
      }
      res.setHeader("content-type", "application/x-ndjson");
      const wait = () => new Promise((r) => setTimeout(r, 15));
      if (m === "ok") {
        for (const c of ["Hel", "lo ", "world"]) {
          res.write(chunk(c));
          await wait();
        }
        res.end(doneChunk());
      } else if (m === "multi-chunk-split") {
        const whole = chunk("split-ok");
        res.write(whole.slice(0, 10));
        await wait();
        res.write(whole.slice(10));
        await wait();
        res.end(doneChunk());
      } else if (m === "empty") {
        res.end(doneChunk());
      } else if (m === "length") {
        res.write(chunk("cut"));
        res.end(doneChunk("length"));
      } else if (m === "no-done") {
        res.write(chunk("partial"));
        res.end();
      } else if (m === "garbage") {
        res.end("this is not json\n");
      } else if (m === "error-line") {
        res.write(chunk("start"));
        res.end(line({ error: "llama runner process has terminated" }));
      } else if (m === "scripted") {
        const step = state.script[Math.min(state.chats.length - 1, state.script.length - 1)] ?? {};
        if (step.text) res.write(chunk(step.text));
        if (step.toolCalls) {
          res.write(
            line({
              model: "m",
              message: {
                role: "assistant",
                content: "",
                tool_calls: step.toolCalls.map((c) => ({ function: c })),
              },
            }),
          );
        }
        res.end(doneChunk());
      } else {
        res.write(chunk("first"));
        // never ends: the client must time out or abort
      }
    })();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const origClose = state.close;
  state.close = () => {
    for (const s of sockets) s.destroy();
    return origClose();
  };
  return state;
}
