import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AgentEvent } from "@agent-studio/contracts";
import { validateEventStream } from "@agent-studio/agent-core";
import { OllamaAdapter, readOllamaPs } from "@agent-studio/adapter-ollama";

/**
 * MANUAL, OPT-IN run against the REAL local Ollama (S6). Skipped unless `AGENT_STUDIO_REAL_OLLAMA` names a model
 * that is ALREADY pulled (this test never pulls anything):
 *
 *   AGENT_STUDIO_REAL_OLLAMA=qwen3:4b pnpm exec vitest run tests/contract/real-ollama.test.ts
 *   (PowerShell: $env:AGENT_STUDIO_REAL_OLLAMA = "qwen3:4b"; …)
 *
 * It sends ONE tiny prompt (at most 256 generated tokens), reads the VRAM twice with their different scopes
 * (`/api/ps` = this model only, `nvidia-smi` = the whole GPU), then unloads the model with `keep_alive: 0` and
 * checks it is gone. Optional: `AGENT_STUDIO_REAL_OLLAMA_OUT` = a JSON file to write the numbers to (keep it
 * OUTSIDE the repo). Nothing here is a pass/fail benchmark; the numbers are what was measured on that machine.
 */
const MODEL = process.env["AGENT_STUDIO_REAL_OLLAMA"]?.trim();
const OUT = process.env["AGENT_STUDIO_REAL_OLLAMA_OUT"]?.trim();
const BASE = "http://127.0.0.1:11434";
const MiB = 1024 * 1024;

const smi = () =>
  new Promise<{ usedMiB: number; totalMiB: number } | null>((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 10_000 },
      (err, stdout) => {
        const m = err ? null : /^\s*(\d+)\s*,\s*(\d+)/.exec(stdout);
        resolve(m ? { usedMiB: Number(m[1]), totalMiB: Number(m[2]) } : null);
      },
    );
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!MODEL)("real Ollama (opt-in, one tiny run)", () => {
  it("streams one reply, reports VRAM from both sources, then unloads the model", async () => {
    const model = MODEL!;
    const adapter = new OllamaAdapter({
      baseUrl: BASE,
      model,
      numPredict: 256,
      idleTimeoutMs: 120_000,
    });
    expect(await adapter.detect()).toBe(true);

    const before = { smi: await smi(), ps: await readOllamaPs({ baseUrl: BASE }) };
    expect(before.ps, "Ollama must answer /api/ps").toBeDefined();

    const events: AgentEvent[] = [];
    const t0 = Date.now();
    let firstTextMs: number | undefined;
    const ac = new AbortController();
    for await (const e of adapter.execute({
      id: "real-1",
      prompt: "Reply with the single word: ok",
      cwd: process.cwd(),
      signal: ac.signal,
    })) {
      if (e.type === "text" && firstTextMs === undefined) firstTextMs = Date.now() - t0;
      events.push(e);
    }
    const totalMs = Date.now() - t0;

    const loaded = await readOllamaPs({ baseUrl: BASE });
    const during = {
      smi: await smi(),
      ps: loaded?.find((m) => m.name.startsWith(model.split(":")[0]!)),
    };

    // Unload, whatever the assertions below say, so the GPU is left as it was found.
    await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
    }).then((r) => r.arrayBuffer());
    let after = await readOllamaPs({ baseUrl: BASE });
    for (let i = 0; i < 20 && after?.some((m) => m.name === during.ps?.name); i++) {
      await sleep(500);
      after = await readOllamaPs({ baseUrl: BASE });
    }
    const afterSmi = await smi();

    const textEvents = events.filter((e) => e.type === "text");
    const report = {
      model,
      events: events.map((e) => e.type),
      textChunks: textEvents.length,
      reply: textEvents
        .map((e) => (e.type === "text" ? e.content : ""))
        .join("")
        .slice(0, 120),
      usage: events.find((e) => e.type === "usage"),
      firstTextMs,
      totalMs,
      gpuBeforeMiB: before.smi,
      gpuDuringMiB: during.smi,
      gpuAfterUnloadMiB: afterSmi,
      ollamaModelDuring: during.ps && {
        sizeMiB: Math.round(during.ps.sizeBytes / MiB),
        sizeVramMiB: Math.round(during.ps.sizeVramBytes / MiB),
        contextLength: during.ps.contextLength,
      },
      ollamaLoadedAfterUnload: (after ?? []).map((m) => m.name),
    };
    console.log(`REAL_OLLAMA_REPORT ${JSON.stringify(report)}`);
    if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));

    expect(validateEventStream(events)).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(textEvents.length).toBeGreaterThan(0);
    expect(during.ps, "the model should be listed by /api/ps while loaded").toBeDefined();
    expect(after?.some((m) => m.name === during.ps?.name)).toBe(false);
  }, 240_000);
});
