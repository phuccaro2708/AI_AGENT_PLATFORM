import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestInsideWorktree } from "./worktree-hash.js";

let dir: string;
let wt: string;
let outside: string;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-wth-"));
  wt = join(dir, "wt");
  outside = join(dir, "outside");
  mkdirSync(wt);
  mkdirSync(outside);
  writeFileSync(join(outside, "f.txt"), "outside-secret");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Replaces `wt/d` (a real folder) by a junction to `outside`, keeping the original as `wt/d.orig`. */
function swapInJunction(): void {
  renameSync(join(wt, "d"), join(wt, "d.orig"));
  symlinkSync(outside, join(wt, "d"), "junction"); // needs no privilege on Windows
}
function swapBack(): void {
  rmSync(join(wt, "d"), { recursive: true, force: false }); // removes the junction, not its target
  renameSync(join(wt, "d.orig"), join(wt, "d"));
}

describe("digestInsideWorktree", () => {
  it("hashes a regular file", () => {
    mkdirSync(join(wt, "d"));
    writeFileSync(join(wt, "d", "f.txt"), "inside");
    expect(digestInsideWorktree(wt, "d/f.txt")).toEqual({ kind: "ok", sha256: sha("inside") });
  });

  it("a file whose NAME starts with two dots is inside the root, not an escape", () => {
    writeFileSync(join(wt, "..notes"), "dots");
    expect(digestInsideWorktree(wt, "..notes")).toEqual({ kind: "ok", sha256: sha("dots") });
  });

  it("refuses a hard link to a file outside the worktree (realpath cannot see it)", () => {
    try {
      linkSync(join(outside, "f.txt"), join(wt, "h.txt"));
    } catch {
      return; // no hard links on this file system: not run
    }
    const d = digestInsideWorktree(wt, "h.txt");
    expect(d.kind).toBe("escapes");
    expect(JSON.stringify(d)).not.toContain(sha("outside-secret"));
  });

  it("refuses a file that has a second name even inside the worktree (cannot know where the other name lives)", () => {
    writeFileSync(join(wt, "a.txt"), "x");
    try {
      linkSync(join(wt, "a.txt"), join(wt, "b.txt"));
    } catch {
      return;
    }
    expect(digestInsideWorktree(wt, "a.txt").kind).toBe("escapes");
  });

  it("TOCTOU: a folder swapped for a junction between the check and the open is detected, not read", () => {
    mkdirSync(join(wt, "d"));
    writeFileSync(join(wt, "d", "f.txt"), "inside");
    const d = digestInsideWorktree(wt, "d/f.txt", { afterResolve: swapInJunction });
    expect(d.kind).toBe("escapes");
    expect(JSON.stringify(d)).not.toContain(sha("outside-secret"));
  });

  it("TOCTOU: swapped in before the open and swapped BACK before the re-check: the handle's identity differs, nothing is read", () => {
    mkdirSync(join(wt, "d"));
    writeFileSync(join(wt, "d", "f.txt"), "inside");
    const d = digestInsideWorktree(wt, "d/f.txt", {
      afterResolve: swapInJunction,
      afterOpen: swapBack,
    });
    expect(d.kind).toBe("escapes");
  });

  it("TOCTOU: swapped in only after the open: never `ok` (on Windows the open handle blocks renaming its folder: `unreadable`; elsewhere the re-check says `escapes`)", () => {
    mkdirSync(join(wt, "d"));
    writeFileSync(join(wt, "d", "f.txt"), "inside");
    const d = digestInsideWorktree(wt, "d/f.txt", { afterOpen: swapInJunction });
    expect(d.kind === "escapes" || d.kind === "unreadable").toBe(true);
    expect(JSON.stringify(d)).not.toContain(sha("outside-secret"));
  });
});
