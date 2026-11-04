import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_LINK_DEPTH = 40;

export class PathError extends Error {}

const IS_WINDOWS = path.sep === "\\";
/** Verbatim (`\\?\`) and device (`\\.\`) prefixes: Win32 does NOT collapse `..` in them, so they bypass the lexical rule below. */
const VERBATIM_OR_DEVICE = /^[\\/]{2}[?.][\\/]/;

function splitSegments(rest: string): string[] {
  const sep = path.sep === "\\" ? /[\\/]+/ : /\/+/;
  return rest.split(sep).filter((s) => s !== "" && s !== ".");
}

function joinRaw(root: string, segs: readonly string[]): string {
  return root + segs.join(path.sep);
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Canonical absolute path of `input`: symlinks resolved, `..` resolved the way the OS does it. POSIX: a `..` after
 * a symlink goes to the link TARGET's parent, so it is never collapsed lexically first. Windows (Win32 API): `..`
 * is collapsed lexically before the file system is touched, so it is collapsed first here too; `\?\` and `\.\`
 * paths (no such collapsing) are rejected.
 *
 * The path need not exist: the longest existing prefix is resolved with `realpath`, the rest is appended. A
 * dangling symlink is followed to where it would create a file. Relative paths, NUL bytes, symlink loops and
 * any unexpected filesystem error throw `PathError` — callers treat that as "deny".
 *
 * Point-in-time answer: the filesystem can change between this check and the use (TOCTOU).
 */
export async function canonicalize(input: string, depth = 0): Promise<string> {
  if (depth > MAX_LINK_DEPTH) throw new PathError("too many symbolic links");
  if (typeof input !== "string" || input === "" || input.includes("\0")) {
    throw new PathError("invalid path");
  }
  if (IS_WINDOWS && VERBATIM_OR_DEVICE.test(input)) {
    throw new PathError("verbatim and device paths are not allowed");
  }
  if (!path.isAbsolute(input)) throw new PathError("path must be absolute");
  if (IS_WINDOWS) input = path.normalize(input);
  const { root } = path.parse(input);
  const segs = splitSegments(input.slice(root.length));

  for (let i = segs.length; i >= 0; i--) {
    const prefix = joinRaw(root, segs.slice(0, i));
    const remaining = segs.slice(i);
    try {
      return path.resolve(await fs.realpath(prefix), ...remaining);
    } catch (e) {
      if (!isMissing(e)) throw new PathError("cannot resolve path");
    }
    // realpath failed with "missing": a dangling symlink would still create its target when written.
    if (i === 0) break;
    let isLink = false;
    try {
      isLink = (await fs.lstat(prefix)).isSymbolicLink();
    } catch (e) {
      if (!isMissing(e)) throw new PathError("cannot resolve path");
    }
    if (isLink) {
      const link = await fs.readlink(prefix);
      const parent = joinRaw(root, segs.slice(0, i - 1));
      const target = path.isAbsolute(link)
        ? link
        : parent + (parent.endsWith(path.sep) ? "" : path.sep) + link;
      const next = remaining.length > 0 ? target + path.sep + remaining.join(path.sep) : target;
      return canonicalize(next, depth + 1);
    }
  }
  throw new PathError("cannot resolve path");
}

/** True if canonical `target` equals `root` or lies below it. Both must already be canonical. */
export function isWithin(root: string, target: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(target)) return false;
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}
