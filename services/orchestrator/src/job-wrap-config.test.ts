import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_MEM_LIMIT_MB,
  resolveJobWrap,
  resolveTreeMemoryLimitMb,
} from "./job-wrap-config.js";

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
    expect(resolveJobWrap(p, {}, w.log)).toEqual({
      path: p,
      jobMemLimitMb: DEFAULT_JOB_MEM_LIMIT_MB,
    });
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

describe("resolveJobWrap: default whole-tree RAM cap (Q3)", () => {
  it("the default is a conservative-but-generous 8192 MB (a failed allocation is not a kill)", () => {
    expect(DEFAULT_JOB_MEM_LIMIT_MB).toBe(8192);
    expect(resolveJobWrap(fakeBinary(), {}, warnings().log)?.jobMemLimitMb).toBe(8192);
  });
  it("AGENT_STUDIO_JOB_MEM_LIMIT_MB overrides it with a positive integer", () => {
    const r = resolveJobWrap(
      fakeBinary(),
      { AGENT_STUDIO_JOB_MEM_LIMIT_MB: "3000" },
      warnings().log,
    );
    expect(r?.jobMemLimitMb).toBe(3000);
  });
  it("0/off/false removes the cap but keeps the wrapper", () => {
    for (const v of ["0", "off", "false"]) {
      const p = fakeBinary();
      expect(resolveJobWrap(p, { AGENT_STUDIO_JOB_MEM_LIMIT_MB: v }, warnings().log)).toEqual({
        path: p,
      });
    }
  });
  it("garbage falls back to the default and warns", () => {
    for (const v of ["abc", "-5", "1.5", "9".repeat(309), "1000000000000000000000", "16777217"]) {
      const w = warnings();
      const r = resolveJobWrap(fakeBinary(), { AGENT_STUDIO_JOB_MEM_LIMIT_MB: v }, w.log);
      expect(r?.jobMemLimitMb).toBe(DEFAULT_JOB_MEM_LIMIT_MB);
      expect(w.seen).toHaveLength(1);
    }
  });
  it("no wrapper binary means no cap either (nothing to apply it)", () => {
    expect(resolveJobWrap(undefined, {}, warnings().log)).toBeUndefined();
  });
});

describe("resolveTreeMemoryLimitMb", () => {
  it("is OFF by default (the watchdog only polls)", () => {
    expect(resolveTreeMemoryLimitMb({})).toBeUndefined();
  });
  it("a positive integer in the env opts in; 0, off and garbage stay off", () => {
    expect(resolveTreeMemoryLimitMb({ AGENT_STUDIO_CLI_TREE_MEM_MB: "2048" })).toBe(2048);
    for (const v of ["0", "off", "-5", "abc", ""]) {
      expect(resolveTreeMemoryLimitMb({ AGENT_STUDIO_CLI_TREE_MEM_MB: v })).toBeUndefined();
    }
  });
});
