import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** S1: the adapter talks HTTP only. It never starts `ollama list` (or any process). */
describe("adapter-ollama starts no process", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("has no child_process import and no `ollama list` in its sources", () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/child_process|execFile|spawn\(/);
      expect(text, f).not.toMatch(/ollama\s+list/);
    }
  });
});
