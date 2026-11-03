import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { canonicalRoot, checkProjectRoot, duplicateOf, isInside } from "./project-policy.js";

let dir: string;
let ctx: { dbPath: string; worktreesDir: string };

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "as-policy-")));
  ctx = { dbPath: join(dir, "data", "s.db"), worktreesDir: join(dir, "data", "wt") };
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "app"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const reason = (raw: string) => {
  const r = checkProjectRoot(raw, ctx);
  return r.ok ? null : r.reason;
};

describe("checkProjectRoot", () => {
  it("accepts an existing folder and returns its canonical path", () => {
    const r = checkProjectRoot(join(dir, "app") + "/", ctx);
    expect(r).toEqual({ ok: true, path: join(dir, "app") });
  });

  it("refuses empty, relative, missing and file paths", () => {
    writeFileSync(join(dir, "f.txt"), "x");
    expect(reason("  ")).toMatch(/empty/);
    expect(reason("app")).toMatch(/absolute/);
    expect(reason(join(dir, "nope"))).toMatch(/does not exist/);
    expect(reason(join(dir, "f.txt"))).toMatch(/file, not a folder/);
  });

  it("refuses a drive root and the home folder", () => {
    expect(reason(parse(dir).root)).toMatch(/whole drive/);
    expect(reason(homedir())).toMatch(/home folder/);
  });

  it("refuses system folders and anything inside them", () => {
    const sys = process.platform === "win32" ? process.env["SystemRoot"]! : "/usr";
    expect(reason(sys)).toMatch(/System folders/);
    expect(reason(join(sys, process.platform === "win32" ? "System32" : "bin"))).toMatch(
      /System folders/,
    );
  });

  it("refuses a folder that holds the database or overlaps the worktrees folder", () => {
    mkdirSync(ctx.worktreesDir);
    writeFileSync(ctx.dbPath, "");
    expect(reason(join(dir, "data"))).toMatch(/database/);
    expect(reason(dir)).toMatch(/database/);
    expect(reason(ctx.worktreesDir)).toMatch(/worktrees/);
  });

  it("allows a sibling of the database file", () => {
    expect(reason(join(dir, "app"))).toBeNull();
  });
});

describe("duplicates and containment", () => {
  it("finds a project that already uses the folder, ignoring case on Windows and a trailing slash", () => {
    const stored = join(dir, "app");
    const probe = process.platform === "win32" ? stored.toUpperCase() : stored;
    expect(
      duplicateOf(canonicalRoot(probe) ?? probe, [{ name: "A", rootPath: stored + sep }]),
    ).toBe("A");
    expect(duplicateOf(stored, [{ name: "B", rootPath: join(dir, "data") }])).toBeUndefined();
  });

  it("isInside treats a prefix-sharing sibling as outside", () => {
    expect(isInside(join(dir, "app2"), join(dir, "app"))).toBe(false);
    expect(isInside(join(dir, "app", "x"), join(dir, "app"))).toBe(true);
  });
});
