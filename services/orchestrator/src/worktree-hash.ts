import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export type WorktreeFileDigest =
  | { kind: "ok"; sha256: string }
  /** Reached through a symlink/junction whose real location is outside the worktree. Never read. */
  | { kind: "escapes"; marker: string }
  /** Missing, a directory or otherwise not a regular file. */
  | { kind: "unreadable" };

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * sha256 of a file in a worktree, fail-closed on links: the real (symlink/junction-resolved) location must
 * stay inside the real worktree root, otherwise the file is NOT read (a link would make the hash an oracle
 * for any file the orchestrator can read). For `escapes` the marker hashes the link text, so a change of the
 * link itself stays visible in snapshots without touching the target. Not a security boundary: a link swapped
 * between the check and the read is still possible (see docs/THREAT_MODEL.md T7).
 */
export function digestInsideWorktree(root: string, rel: string): WorktreeFileDigest {
  const full = join(root, rel);
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
    real = realpathSync.native(full);
  } catch {
    return { kind: "unreadable" }; // gone, a dangling link, a loop: nothing safe to read
  }
  const r = relative(realRoot, real);
  const inside = r !== "" && !r.startsWith("..") && !isAbsolute(r);
  if (!inside) {
    let linkText = real;
    try {
      if (lstatSync(full).isSymbolicLink()) linkText = readlinkSync(full);
    } catch {
      // keep the resolved location as the marker
    }
    return { kind: "escapes", marker: `escapes:${sha(linkText)}` };
  }
  try {
    if (!lstatSync(real).isFile()) return { kind: "unreadable" };
    return { kind: "ok", sha256: sha(readFileSync(real)) };
  } catch {
    return { kind: "unreadable" };
  }
}
