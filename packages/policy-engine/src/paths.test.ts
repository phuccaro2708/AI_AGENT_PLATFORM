import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize, isWithin } from "./paths.js";
import { canSymlink, makeTree } from "./test-helpers.js";

const trees: Array<() => void> = [];
const tree = () => {
  const t = makeTree();
  trees.push(t.cleanup);
  return t;
};
afterEach(() => trees.splice(0).forEach((c) => c()));
const symlinks = canSymlink();
/** Joins WITHOUT collapsing "..", unlike path.join, so the engine sees what an agent would send. */
const raw = (...parts: string[]) => parts.join(path.sep);

describe("canonicalize", () => {
  it("collapses .. and . in plain paths", async () => {
    const { ws } = tree();
    expect(await canonicalize(path.join(ws, "src", "..", "src", ".", "a.txt"))).toBe(
      path.join(ws, "src", "a.txt"),
    );
  });

  it("resolves a not-yet-existing file below an existing folder", async () => {
    const { ws } = tree();
    expect(await canonicalize(path.join(ws, "src", "new", "deep.txt"))).toBe(
      path.join(ws, "src", "new", "deep.txt"),
    );
  });

  it("rejects relative paths, empty strings and NUL bytes", async () => {
    await expect(canonicalize("src/a.txt")).rejects.toThrow();
    await expect(canonicalize("")).rejects.toThrow();
    await expect(canonicalize(path.join(tree().ws, "a\0b"))).rejects.toThrow();
  });

  it.skipIf(!symlinks)("follows a symlink to its real location", async () => {
    const { ws, outside } = tree();
    fs.symlinkSync(outside, path.join(ws, "link"), "dir");
    expect(await canonicalize(path.join(ws, "link", "secret.txt"))).toBe(
      path.join(outside, "secret.txt"),
    );
  });

  it.skipIf(!symlinks)(
    "resolves .. after a symlink against the link TARGET, not lexically",
    async () => {
      const { ws, outside } = tree();
      fs.mkdirSync(path.join(outside, "sub"));
      fs.symlinkSync(path.join(outside, "sub"), path.join(ws, "link"), "dir");
      // lexically ws/link/../x is ws/x; the OS goes to outside/x
      expect(await canonicalize(raw(ws, "link", "..", "x"))).toBe(path.join(outside, "x"));
    },
  );

  it.skipIf(!symlinks)("follows a dangling symlink to where a write would land", async () => {
    const { ws, outside } = tree();
    fs.symlinkSync(path.join(outside, "new.txt"), path.join(ws, "dangling"), "file");
    expect(await canonicalize(path.join(ws, "dangling"))).toBe(path.join(outside, "new.txt"));
  });

  it.skipIf(!symlinks)("throws on a symlink loop", async () => {
    const { ws } = tree();
    fs.symlinkSync(path.join(ws, "b"), path.join(ws, "a"));
    fs.symlinkSync(path.join(ws, "a"), path.join(ws, "b"));
    await expect(canonicalize(path.join(ws, "a", "x"))).rejects.toThrow();
  });
});

describe("isWithin", () => {
  it("accepts the root itself and descendants, rejects siblings and look-alike prefixes", () => {
    const root = path.resolve("/tmp/ws");
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, path.join(root, "a", "b"))).toBe(true);
    expect(isWithin(root, path.resolve("/tmp/ws2"))).toBe(false);
    expect(isWithin(root, path.resolve("/tmp"))).toBe(false);
    expect(isWithin(root, path.join(root, "..", "x"))).toBe(false);
  });

  it("treats a child literally named '..foo' as inside", () => {
    const root = path.resolve("/tmp/ws");
    expect(isWithin(root, path.join(root, "..foo"))).toBe(true);
  });

  it("is false for relative inputs", () => {
    expect(isWithin("ws", "ws/a")).toBe(false);
  });
});
