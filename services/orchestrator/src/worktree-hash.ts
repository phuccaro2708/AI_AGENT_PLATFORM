import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export type WorktreeFileDigest =
  | { kind: "ok"; sha256: string }
  /** Reached through a symlink/junction whose real location is outside the worktree. Never read. */
  | { kind: "escapes"; marker: string }
  /** Missing, a directory or otherwise not a regular file. */
  | { kind: "unreadable" };

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Test seam only: lets a test swap the file between the steps of `digestInsideWorktree` (TOCTOU). */
export interface DigestHooks {
  /** After the real path was resolved and checked, before the file is opened. */
  afterResolve?: () => void;
  /** After the file was opened, before identity is re-checked and content is read. */
  afterOpen?: () => void;
}

const escapes = (text: string): WorktreeFileDigest => ({
  kind: "escapes",
  marker: `escapes:${sha(text)}`,
});

const insideRoot = (realRoot: string, real: string): boolean => {
  const r = relative(realRoot, real);
  // A file NAMED "..notes" is inside the root; only a real ".." path segment leaves it.
  return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
};

/**
 * sha256 of a file in a worktree, fail-closed on links: the real (symlink/junction-resolved) location must
 * stay inside the real worktree root, otherwise the file is NOT read (a link would make the hash an oracle
 * for any file the orchestrator can read). For `escapes` the marker hashes the link text, so a change of the
 * link itself stays visible in snapshots without touching the target.
 *
 * Also refused as `escapes` (never read):
 *  - a file with more than one hard link: another name for it may live outside the worktree and `realpath` cannot
 *    tell (it only follows symlinks/junctions);
 *  - a file whose volume differs from the worktree root's (a volume mount point inside the worktree).
 *
 * TOCTOU: the file is opened ONCE and the content is read from that handle. After opening, the path is resolved
 * again and must still be inside the root and name the SAME file (device + inode) as the handle, so a link swapped
 * in (and possibly swapped back) between the check and the open is detected instead of read. Not a security
 * boundary: a process that keeps swapping can only make the call fail, but a swap that is undone after the final
 * re-check still cannot change which file the open handle reads.
 */
export function digestInsideWorktree(
  root: string,
  rel: string,
  hooks: DigestHooks = {},
): WorktreeFileDigest {
  const full = join(root, rel);
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
    real = realpathSync.native(full);
  } catch {
    return { kind: "unreadable" }; // gone, a dangling link, a loop: nothing safe to read
  }
  if (!insideRoot(realRoot, real)) {
    let linkText = real;
    try {
      if (lstatSync(full).isSymbolicLink()) linkText = readlinkSync(full);
    } catch {
      // keep the resolved location as the marker
    }
    return escapes(linkText);
  }
  hooks.afterResolve?.();
  let fd: number | undefined;
  try {
    fd = openSync(real, "r");
    hooks.afterOpen?.();
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return { kind: "unreadable" };
    // Re-resolve after the open: still inside, and the same file as the handle.
    const again = realpathSync.native(full);
    if (again !== real || !insideRoot(realRoot, again)) return escapes(`moved:${again}`);
    const now = statSync(real, { bigint: true });
    if (now.dev !== opened.dev || now.ino !== opened.ino) return escapes(`swapped:${real}`);
    if (opened.nlink > 1n) return escapes(`hardlink:${opened.dev}:${opened.ino}:${opened.nlink}`);
    const rootStat = statSync(realRoot, { bigint: true });
    if (rootStat.dev !== opened.dev) return escapes(`volume:${opened.dev}:${opened.ino}`);
    return { kind: "ok", sha256: sha(readFileSync(fd)) };
  } catch {
    return { kind: "unreadable" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
