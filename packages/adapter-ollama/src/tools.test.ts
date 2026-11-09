import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LIST_ENTRIES, MAX_READ_BYTES, READ_ONLY_TOOLS, runReadOnlyTool } from "./tools.js";

let dir: string;
let root: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-oll-"));
  root = join(dir, "proj");
  outside = join(dir, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "a.txt"), "hello");
  writeFileSync(join(root, "src", "b.ts"), "export {};");
  writeFileSync(join(outside, "secret.txt"), "outside-secret");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (path: unknown) => runReadOnlyTool("read_file", { path }, root);
const list = (path: unknown) => runReadOnlyTool("list_dir", { path }, root);

describe("read-only tools", () => {
  it("offers exactly list_dir and read_file", () => {
    expect(READ_ONLY_TOOLS.map((t) => t.function.name)).toEqual(["list_dir", "read_file"]);
  });

  it("reads a file and lists a folder (folders get a trailing slash)", () => {
    expect(read("a.txt")).toEqual({ ok: true, content: "hello" });
    expect(read("src/b.ts")).toEqual({ ok: true, content: "export {};" });
    expect(list(".")).toEqual({ ok: true, content: "a.txt\nsrc/" });
  });

  it("runs nothing that is not on the whitelist", () => {
    for (const name of ["write_file", "shell", "bash", "delete_file", "read_file ", ""]) {
      const r = runReadOnlyTool(name, { path: "a.txt", content: "x" }, root);
      expect(r.ok).toBe(false);
    }
    expect(read("a.txt").content).toBe("hello"); // nothing was written
  });

  it("refuses paths that leave the folder", () => {
    for (const p of ["..", "../outside/secret.txt", "src/../../outside/secret.txt"]) {
      const r = read(p);
      expect(r.ok, p).toBe(false);
      expect(r.content).not.toContain("outside-secret");
    }
    expect(read(join(outside, "secret.txt")).content).toMatch(/absolute/);
  });

  it("a name that merely starts with two dots is inside the folder", () => {
    writeFileSync(join(root, "..notes"), "dots");
    expect(read("..notes")).toEqual({ ok: true, content: "dots" });
  });

  it("refuses a junction/symlink to a folder outside", () => {
    symlinkSync(outside, join(root, "link"), "junction"); // needs no privilege on Windows
    const r = read("link/secret.txt");
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("outside-secret");
    expect(list("link").ok).toBe(false);
  });

  it("refuses a hard link to a file outside (realpath cannot see it)", () => {
    try {
      linkSync(join(outside, "secret.txt"), join(root, "h.txt"));
    } catch {
      return; // no hard links on this file system: not run
    }
    const r = read("h.txt");
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("outside-secret");
  });

  it("refuses names that usually hold secrets and the .git folder", () => {
    mkdirSync(join(root, ".git"));
    for (const f of [
      ".env",
      ".env.local",
      "id_rsa",
      "server.pem",
      "x.key",
      ".npmrc",
      ".git/config",
    ]) {
      writeFileSync(join(root, f), "TOKEN=1");
      expect(read(f).ok, f).toBe(false);
    }
    expect(list(".git").ok).toBe(false);
    writeFileSync(join(root, "environment.md"), "fine"); // not a dotenv file
    expect(read("environment.md").ok).toBe(true);
  });

  it("refuses bad input without throwing", () => {
    for (const p of [undefined, null, 5, "", "a\0b", "nope.txt", {}]) {
      expect(read(p).ok).toBe(false);
    }
    expect(runReadOnlyTool("read_file", undefined, root).ok).toBe(false);
    expect(runReadOnlyTool("read_file", "a.txt", root).ok).toBe(false);
    expect(read("src").ok).toBe(false); // a folder is not a file
    expect(list("a.txt").ok).toBe(false); // a file is not a folder
  });

  it("truncates big files, refuses binary ones, and caps long listings", () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(MAX_READ_BYTES + 100));
    const big = read("big.txt");
    expect(big.ok).toBe(true);
    expect(big.content.startsWith("x".repeat(MAX_READ_BYTES))).toBe(true);
    expect(big.content).toMatch(/truncated at 32768 bytes/);
    writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    expect(read("bin.dat")).toEqual({ ok: false, content: "binary file" });
    writeFileSync(join(root, "empty.txt"), "");
    expect(read("empty.txt")).toEqual({ ok: true, content: "" });
    mkdirSync(join(root, "many"));
    for (let i = 0; i < MAX_LIST_ENTRIES + 5; i++)
      writeFileSync(join(root, "many", `f${String(i)}`), "");
    const l = list("many");
    expect(l.content.split("\n")).toHaveLength(MAX_LIST_ENTRIES + 1);
    expect(l.content).toMatch(/… 5 more$/);
  });
});
