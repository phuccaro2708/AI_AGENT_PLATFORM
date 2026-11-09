import { describe, expect, it } from "vitest";
import { listOllamaModels } from "./models.js";

const reply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("listOllamaModels", () => {
  it("lists several installed models, sorted, skipping malformed entries", async () => {
    const out = await listOllamaModels({
      fetch: reply({
        models: [
          {
            name: "b:latest",
            size: 2,
            details: { parameter_size: "4B", quantization_level: "Q4" },
          },
          { name: "a:7b", size: 1 },
          { size: 5 },
          { name: "" },
        ],
      }),
    });
    expect(out).toEqual([
      { name: "a:7b", sizeBytes: 1 },
      { name: "b:latest", sizeBytes: 2, parameterSize: "4B", quantization: "Q4" },
    ]);
  });

  it("returns [] (reachable, nothing pulled) apart from undefined (unreachable)", async () => {
    expect(await listOllamaModels({ fetch: reply({ models: [] }) })).toEqual([]);
    expect(await listOllamaModels({ fetch: reply({}, 500) })).toBeUndefined();
    expect(await listOllamaModels({ fetch: reply({ nope: 1 }) })).toBeUndefined();
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await listOllamaModels({ fetch: down })).toBeUndefined();
  });

  it("refuses a non-loopback server without asking it", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(
      await listOllamaModels({ baseUrl: "http://example.com:11434", fetch: spy }),
    ).toBeUndefined();
    expect(called).toBe(false);
  });
});
