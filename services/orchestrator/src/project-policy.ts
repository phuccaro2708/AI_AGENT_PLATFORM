import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

/**
 * Policy for `projects.rootPath` (Phase 7B). An agent works inside this folder, so a path that is
 * too broad (a drive root, the home folder, system folders) or that holds Agent Workspace's own data
 * is refused. This is a guard against picking the wrong folder, not a sandbox: an agent that runs
 * in a valid root can still reach other places the CLI itself allows.
 */
export interface RootPolicyContext {
  /** The SQLite file. A root that contains it would expose the app's own state to the agent. */
  dbPath: string;
  /** Where agent worktrees live. A root may neither contain it nor sit inside it. */
  worktreesDir: string;
}

export type RootCheck = { ok: true; path: string } | { ok: false; reason: string };

const WIN = process.platform === "win32";
const key = (p: string) => (WIN ? p.toLowerCase() : p);

/** True when `child` is `parent` or inside it (both already canonical). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(key(parent), key(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function systemDirs(): string[] {
  const env = process.env;
  const dirs = WIN
    ? [
        env["SystemRoot"],
        env["windir"],
        env["ProgramFiles"],
        env["ProgramFiles(x86)"],
        env["ProgramData"],
      ]
    : ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var", "/sys", "/proc", "/boot", "/dev"];
  return dirs.filter((d): d is string => typeof d === "string" && d !== "");
}

const real = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/** Canonical form used for storing and comparing roots (no trailing separator, real casing). */
export function canonicalRoot(p: string): string | undefined {
  const r = real(p);
  if (r === undefined) return undefined;
  const root = parse(r).root;
  return r.length > root.length ? r.replace(/[\\/]+$/, "") : r;
}

/** Checks everything that does not depend on other projects. Returns the canonical path to store. */
export function checkProjectRoot(raw: string, ctx: RootPolicyContext): RootCheck {
  const input = raw.trim();
  if (input === "") return { ok: false, reason: "The project folder is empty" };
  if (!isAbsolute(input)) {
    return { ok: false, reason: `The project folder must be an absolute path: ${input}` };
  }
  if (!existsSync(input)) return { ok: false, reason: `The folder does not exist: ${input}` };
  if (!statSync(input).isDirectory()) {
    return { ok: false, reason: `The project path is a file, not a folder: ${input}` };
  }
  const path = canonicalRoot(input);
  if (path === undefined) return { ok: false, reason: `The folder cannot be read: ${input}` };

  if (key(parse(path).root) === key(path)) {
    return {
      ok: false,
      reason: "A whole drive is too broad for a project folder; pick a subfolder",
    };
  }
  const home = real(homedir());
  if (home !== undefined && key(home) === key(path)) {
    return { ok: false, reason: "Your home folder is too broad for a project folder" };
  }
  for (const dir of systemDirs()) {
    const d = real(dir) ?? resolve(dir);
    if (isInside(path, d)) {
      return { ok: false, reason: `System folders cannot be a project folder: ${d}` };
    }
  }
  const db = real(ctx.dbPath) ?? resolve(ctx.dbPath);
  if (isInside(db, path)) {
    return { ok: false, reason: "This folder contains Agent Workspace's own database" };
  }
  const wt = real(ctx.worktreesDir) ?? resolve(ctx.worktreesDir);
  if (isInside(path, wt) || isInside(wt, path)) {
    return { ok: false, reason: "This folder overlaps Agent Workspace's worktrees folder" };
  }
  return { ok: true, path };
}

/** The project that already uses this folder, if any (case-insensitive on Windows). */
export function duplicateOf(
  path: string,
  projects: { name: string; rootPath: string }[],
): string | undefined {
  return projects.find((p) => key(canonicalRoot(p.rootPath) ?? p.rootPath) === key(path))?.name;
}
