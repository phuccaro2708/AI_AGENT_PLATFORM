import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJobWrap, resolveTreeMemoryLimitMb } from "./job-wrap-config.js";

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const warnings = () => {
  const seen: string[] = [];
  return { seen, log: { warn: (_o: object, m: string) => void seen.push(m) } };
};
function fakeBinary(): string {
  const d = mkdtempSync(join(tmpdir(), "as-jwc-"));
  dirs.push(d);
  const p = join(d, "agent-job-wrap.exe");
  writeFileSync(p, "x");
  return p;
}

describe("resolveJobWrap", () => {
  it("is ON by default when the binary exists", () => {
    const p = fakeBinary();
    const w = warnings();
    expect(resolveJobWrap(p, {}, w.log)).toEqual({ path: p });
    expect(w.seen).toEqual([]);
  });
  it("missing, relative or absent location: no wrap and a warning, never a throw", () => {
    for (const loc of [
      join(tmpdir(), "nope", "agent-job-wrap.exe"),
      "rel/agent-job-wrap",
      undefined,
    ]) {
      const w = warnings();
      expect(resolveJobWrap(loc, {}, w.log)).toBeUndefined();
      expect(w.seen).toHaveLength(1);
    }
  });
  it("AGENT_STUDIO_JOB_WRAP=0/off turns it off quietly", () => {
    const p = fakeBinary();
    for (const v of ["0", "off", "false"]) {
      const w = warnings();
      expect(resolveJobWrap(p, { AGENT_STUDIO_JOB_WRAP: v }, w.log)).toBeUndefined();
      expect(w.seen).toEqual([]);
    }
  });
});

describe("resolveTreeMemoryLimitMb", () => {
  it("defaults to min(8192 MB, half of RAM), at least 1024", () => {
    expect(resolveTreeMemoryLimitMb({}, 32 * GB)).toBe(8192);
    expect(resolveTreeMemoryLimitMb({}, 8 * GB)).toBe(4096);
    expect(resolveTreeMemoryLimitMb({}, 1 * GB)).toBe(1024);
  });
  it("env overrides it; 0/off disables; garbage falls back to the default", () => {
    expect(resolveTreeMemoryLimitMb({ AGENT_STUDIO_CLI_TREE_MEM_MB: "2048" }, 32 * GB)).toBe(2048);
    expect(
      resolveTreeMemoryLimitMb({ AGENT_STUDIO_CLI_TREE_MEM_MB: "0" }, 32 * GB),
    ).toBeUndefined();
    expect(
      resolveTreeMemoryLimitMb({ AGENT_STUDIO_CLI_TREE_MEM_MB: "off" }, 32 * GB),
    ).toBeUndefined();
    expect(resolveTreeMemoryLimitMb({ AGENT_STUDIO_CLI_TREE_MEM_MB: "-5" }, 32 * GB)).toBe(8192);
  });
});
