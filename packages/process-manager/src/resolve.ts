import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";

export type ExecutableKind = "exe" | "shim";

export interface ResolvedExecutable {
  path: string;
  /** `shim` = a `.cmd`/`.bat` script on Windows. It is NOT spawnable with `shell:false`. */
  kind: ExecutableKind;
  /** Arguments that must precede the caller's own (set by `unwrapNpmShim`: the script for `node`). */
  prefixArgs?: string[];
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

/** `undefined` = not something Windows can start (e.g. npm's extensionless sh-shim next to `foo.cmd`). */
function classify(path: string, platform: NodeJS.Platform): ExecutableKind | undefined {
  if (platform !== "win32") return "exe";
  const ext = win32.extname(path).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") return "shim";
  return ext === ".exe" || ext === ".com" ? "exe" : undefined;
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
      const kind = classify(candidate, platform);
      if (kind && isFile(candidate, platform)) return { path: candidate, kind };
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

/**
 * Maps an npm-generated `.cmd` shim to `node <script.js>` so it can run with `shell:false`.
 * Only reads the shim text; never executes it. Returns `undefined` unless the shim has the
 * npm form `"%_prog%" "%dp0%\<script>.js"` and the script is an existing file inside the shim's directory.
 */
export function unwrapNpmShim(shim: ResolvedExecutable): ResolvedExecutable | undefined {
  if (shim.kind !== "shim") return undefined;
  let text: string;
  try {
    text = readFileSync(shim.path, "utf8");
  } catch {
    return undefined;
  }
  const m = /"%_prog%"\s+"%dp0%[\\/]+([^"%]+\.js)"/i.exec(text);
  if (!m?.[1]) return undefined;
  const dir = dirname(shim.path);
  const script = resolve(dir, ...m[1].split(/[\\/]+/));
  const rel = relative(dir, script);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  try {
    if (!statSync(script).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const local = join(dir, "node.exe"); // npm's shim prefers a node.exe sitting next to it
  let node = process.execPath;
  try {
    if (statSync(local).isFile()) node = local;
  } catch {
    // no local node: use the running one
  }
  return { path: node, kind: "exe", prefixArgs: [script] };
}

function envGet(env: Record<string, string | undefined>, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((e) => e.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : env[k];
}
