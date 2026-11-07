// Offline test for the release-age gate's allowlist (scripts/deps-age-audit.mjs --rows-from/--allowlist).
// No registry request: rows come from a synthetic fixture written to a temp dir; real data is never touched.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const script = resolve(here, "../../scripts/deps-age-audit.mjs");
const realAllowlist = resolve(here, "../../scripts/deps-age-allowlist.json");
let dir: string;

const rows = [
  { eco: "cargo", id: "old@1.0.0", direct: false, published: "2026-01-01T00:00:00Z", path: null },
  { eco: "cargo", id: "young@1.0.0", direct: false, published: "2026-10-30T00:00:00Z", path: null },
];

function run(now: string, allowlist: unknown) {
  const allow = join(dir, "allow.json");
  writeFileSync(allow, JSON.stringify(allowlist));
  const r = spawnSync(
    process.execPath,
    [script, "--cargo", "--now", now, "--rows-from", join(dir, "rows.json"), "--allowlist", allow],
    { encoding: "utf8", shell: false },
  );
  return { code: r.status, out: r.stdout };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "deps-age-"));
  writeFileSync(join(dir, "rows.json"), JSON.stringify({ rows }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("deps-age-audit allowlist", () => {
  const entry = { id: "young@1.0.0", reason: "transitive, no advisory", expires: "2026-11-08" };

  it("exits 1 for a young package with no allowlist entry", () => {
    expect(run("2026-11-06T00:00:00Z", []).code).toBe(1);
  });

  it("exits 0 while the entry is unexpired", () => {
    expect(run("2026-11-06T00:00:00Z", [entry]).code).toBe(0);
  });

  it("exits 1 again once the entry has expired (simulated clock, package may still be young)", () => {
    const r = run("2026-11-09T00:00:00Z", [entry]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("YOUNG young@1.0.0");
  });

  it("ignores entries without a reason", () => {
    expect(run("2026-11-06T00:00:00Z", [{ ...entry, reason: "" }]).code).toBe(1);
  });
});

describe("scripts/deps-age-allowlist.json (real file)", () => {
  const list = JSON.parse(readFileSync(realAllowlist, "utf8")) as {
    id: string;
    reason: string;
    expires: string;
  }[];

  it("every entry has id, reason and a valid expiry", () => {
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) {
      expect(e.id).toMatch(/^[^@\s]+@\d/);
      expect(e.reason.length).toBeGreaterThan(10);
      expect(Number.isNaN(Date.parse(e.expires))).toBe(false);
    }
  });
});
