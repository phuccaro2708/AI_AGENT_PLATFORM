import { describe, expect, it } from "vitest";
import { resolveOllama, VRAM_KEEP_ALIVE, vramKeepAlive } from "./ollama-config.js";

const warnings: string[] = [];
const log = { warn: (_o: object, m: string) => void warnings.push(m) };
const run = (env: Record<string, string>) => {
  warnings.length = 0;
  return resolveOllama(env, log);
};

describe("resolveOllama", () => {
  it("returns nothing when nothing is set", () => {
    expect(run({})).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("takes a valid model, a loopback URL and the read-only tool switch", () => {
    expect(
      run({
        AGENT_STUDIO_OLLAMA_MODEL: " owner/qwen3.8:latest ",
        AGENT_STUDIO_OLLAMA_URL: "http://localhost:11434/",
        AGENT_STUDIO_OLLAMA_TOOLS: "Read-Only",
      }),
    ).toEqual({
      model: "owner/qwen3.8:latest",
      baseUrl: "http://localhost:11434",
      tools: "read-only",
    });
    expect(warnings).toEqual([]);
  });

  it("drops a bad model name, a non-loopback URL, and any other tools value, with warnings", () => {
    expect(
      run({
        AGENT_STUDIO_OLLAMA_MODEL: "m; rm -rf /",
        AGENT_STUDIO_OLLAMA_URL: "http://10.0.0.5:11434",
        AGENT_STUDIO_OLLAMA_TOOLS: "all",
      }),
    ).toEqual({});
    expect(warnings).toHaveLength(2);
  });
});

describe("vramKeepAlive", () => {
  const band = { reduceAt: 80, pauseAt: 95 };
  it("is a short keep_alive only while a VRAM band is saved", () => {
    expect(VRAM_KEEP_ALIVE).toBe("30s");
    expect(vramKeepAlive({ vram: band })).toBe(VRAM_KEEP_ALIVE);
    expect(vramKeepAlive({})).toBeUndefined();
    expect(vramKeepAlive({ vram: undefined })).toBeUndefined();
  });
});
