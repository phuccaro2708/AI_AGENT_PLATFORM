import { describe, expect, it } from "vitest";
import type { ResourceReport } from "./api";
import { vramLines } from "./vramText";

const base: ResourceReport["status"] = {
  concurrency: 2,
  effectiveConcurrency: 2,
  running: 0,
  queued: 0,
  monitor: null,
  gpu: null,
  ollama: null,
};
const GIB = 1024 ** 3;

describe("vramLines", () => {
  it("is empty when neither source is available", () => {
    expect(vramLines(base)).toEqual([]);
  });

  it("names the scope of each figure and does not merge them", () => {
    const lines = vramLines({
      ...base,
      gpu: { usedBytes: 6 * GIB, totalBytes: 8 * GIB, scope: "whole-gpu" },
      ollama: {
        scope: "ollama-models",
        models: [{ name: "m:latest", sizeBytes: 8 * GIB, sizeVramBytes: 4 * GIB }],
      },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/whole GPU.*nvidia-smi.*6\.0 GB of 8\.0 GB \(75%\)/);
    expect(lines[1]).toMatch(/m:latest, this model only: 4\.0 GB .*of 8\.0 GB \(50% of the model/);
  });

  it("handles a model reported with size 0 without dividing by zero", () => {
    const lines = vramLines({
      ...base,
      ollama: { scope: "ollama-models", models: [{ name: "x", sizeBytes: 0, sizeVramBytes: 0 }] },
    });
    expect(lines[0]).not.toMatch(/NaN|Infinity/);
  });
});
