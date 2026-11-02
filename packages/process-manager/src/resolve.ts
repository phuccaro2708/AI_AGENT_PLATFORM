import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";

export type ExecutableKind = "exe" | "shim";

export interface ResolvedExecutable {
  path: string;
  /** `shim` = a `.cmd`/`.bat` script on Windows. It is NOT spawnable with `shell:false`. */
  kind: ExecutableKind;
}

export class ExecutableNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`Executable not found: ${command}`);
    this.name = "ExecutableNotFoundError";
  }
}

export class UnsupportedShimError extends Error {
  constructor(readonly path: string) {
    super(
      `Refusing to run Windows shim ${path} (.cmd/.bat). Spawning it needs a shell, which this project forbids ` +
        "(CLAUDE.md principle 3). Resolve the shim to its real target (a .exe or `node <script>`) instead.",
    );
    this.name = "UnsupportedShimError";
  }
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  cwd?: string;
  /** Injectable for tests. Must return true only for regular files. */
  isFile?: (path: string, platform: NodeJS.Platform) => boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function defaultIsFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function classify(path: string, platform: NodeJS.Platform): ExecutableKind {
  if (platform !== "win32") return "exe";
  const ext = win32.extname(path).toLowerCase();
  return ext === ".cmd" || ext === ".bat" ? "shim" : "exe";
}

/**
 * Finds the file that `command` refers to, mimicking PATH (+ PATHEXT on Windows) lookup.
 * Pure lookup: never executes anything.
 */
export function resolveExecutable(command: string, opts: ResolveOptions = {}): ResolvedExecutable {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? defaultIsFile;
  const pathMod = platform === "win32" ? win32 : { join, isAbsolute, delimiter };
  const sep = platform === "win32" ? ";" : delimiter;

  const exts =
    platform === "win32"
      ? (envGet(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").filter(Boolean)
      : [];
  const suffixes = platform === "win32" ? ["", ...exts] : [""];

  const tryBase = (base: string): ResolvedExecutable | undefined => {
    for (const suffix of suffixes) {
      const candidate = base + suffix;
      if (isFile(candidate, platform))
        return { path: candidate, kind: classify(candidate, platform) };
    }
    return undefined;
  };

  const hasDir = command.includes("/") || (platform === "win32" && command.includes("\\"));
  if (hasDir || pathMod.isAbsolute(command)) {
    const base = pathMod.isAbsolute(command)
      ? command
      : pathMod.join(opts.cwd ?? process.cwd(), command);
    const found = tryBase(base);
    if (found) return found;
    throw new ExecutableNotFoundError(command);
  }

  const dirs = (envGet(env, "PATH") ?? "").split(sep).filter(Boolean);
  // Windows also searches the current directory first; we deliberately do NOT (planting risk).
  for (const dir of dirs) {
    const found = tryBase(pathMod.join(dir, command));
    if (found) return found;
  }
  throw new ExecutableNotFoundError(command);
}

function envGet(env: Record<string, string | undefined>, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((e) => e.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : env[k];
}
