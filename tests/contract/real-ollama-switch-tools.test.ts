import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@agent-studio/contracts";
import { OllamaAdapter, readOllamaPs } from "@agent-studio/adapter-ollama";

/**
 * MANUAL, OPT-IN runs against the REAL local Ollama. Never pulls a model. Set
 *   AGENT_STUDIO_REAL_OLLAMA_PAIR="qwen3:4b,qwen3.5:4b"   (two models ALREADY pulled)
 *   AGENT_STUDIO_REAL_OLLAMA_TOOLS="qwen3:4b"             (one model already pulled)
 * Numbers go to the console as REAL_OLLAMA_* lines; nothing here is a benchmark. Models are unloaded at the end.
 */
const PAIR = process.env["AGENT_STUDIO_REAL_OLLAMA_PAIR"]?.split(",").map((s) => s.trim());
const TOOLS = process.env["AGENT_STUDIO_REAL_OLLAMA_TOOLS"]?.trim();
const BASE = "http://127.0.0.1:11434";
/** Optional: append each REAL_OLLAMA_* line to this file (keep it OUTSIDE the repo). */
const OUT = process.env["AGENT_STUDIO_REAL_OLLAMA_OUT"]?.trim();
const note = (line: string) => {
  console.log(line);
  if (OUT)
    appendFileSync(
      OUT,
      `${line}
`,
    );
};

const unload = (model: string) =>
  fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).then((r) => r.arrayBuffer());
const loaded = async () => (await readOllamaPs({ baseUrl: BASE }))?.map((m) => m.name) ?? [];

async function collect(a: OllamaAdapter, id: string, prompt: string, cwd: string) {
  const events: AgentEvent[] = [];
  for await (const e of a.execute({ id, prompt, cwd, signal: new AbortController().signal }))
    events.push(e);
  return events;
}

describe.skipIf(!PAIR || PAIR.length !== 2)("real Ollama: two models one after the other", () => {
  it("only the model of the latest run stays loaded", async () => {
    const [a, b] = PAIR!;
    const mk = (model: string) =>
      new OllamaAdapter({ baseUrl: BASE, model, numPredict: 256, idleTimeoutMs: 180_000 });
    const dir = mkdtempSync(join(tmpdir(), "as-real-"));
    try {
      const ea = await collect(mk(a!), "r1", "Reply with the single word: ok", dir);
      const afterA = await loaded();
      const eb = await collect(mk(b!), "r2", "Reply with the single word: ok", dir);
      const afterB = await loaded();
      note(`REAL_OLLAMA_SWITCH ${JSON.stringify({ a, b, afterA, afterB })}`);
      expect(ea.at(-1)?.type, JSON.stringify(ea.at(-1))).toBe("completed");
      expect(eb.at(-1)?.type, JSON.stringify(eb.at(-1))).toBe("completed");
      expect(afterA.some((n) => n.startsWith(a!.split(":")[0]!))).toBe(true);
      expect(afterB).toHaveLength(1);
      expect(afterB[0]!.startsWith(b!.split(":")[0]!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await unload(a!);
      await unload(b!);
    }
  }, 400_000);
});

describe.skipIf(!TOOLS)("real Ollama: read-only tool calling", () => {
  it("a real model asks for read_file, the adapter runs it inside the folder, the reply uses the content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-real-"));
    const secret = "ZX-4417-KESTREL";
    writeFileSync(join(dir, "note.txt"), `the access code is ${secret}\n`);
    try {
      const a = new OllamaAdapter({
        baseUrl: BASE,
        model: TOOLS!,
        tools: "read-only",
        numPredict: 512,
        idleTimeoutMs: 180_000,
      });
      const events = await collect(
        a,
        "tools-1",
        "Use the read_file tool to read note.txt, then tell me the access code it contains.",
        dir,
      );
      const calls = events.filter((e) => e.type === "tool_call");
      const results = events.filter((e) => e.type === "tool_result");
      const reply = events.map((e) => (e.type === "text" ? e.content : "")).join("");
      note(
        `REAL_OLLAMA_TOOLS ${JSON.stringify({
          model: TOOLS,
          counts: events.reduce<Record<string, number>>(
            (m, e) => ({ ...m, [e.type]: (m[e.type] ?? 0) + 1 }),
            {},
          ),
          calls: calls.map((e) => (e.type === "tool_call" ? [e.name, e.args] : null)),
          replyHasCode: reply.includes(secret),
          last: events.at(-1),
        })}`,
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(results.length).toBe(calls.length);
      expect(events.at(-1)).toEqual({ type: "completed" });
      expect(reply).toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await unload(TOOLS!);
    }
  }, 400_000);
});
