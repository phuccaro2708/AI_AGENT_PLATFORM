import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The only tools the model may call (S2): read-only, confined to the task's working directory, small outputs.
 * Nothing here writes, runs a program or touches the network. It is a guard against a confused model, not a
 * sandbox (docs/THREAT_MODEL.md): a process that swaps links while it runs can still race the checks.
 */
export const MAX_READ_BYTES = 32 * 1024;
export const MAX_LIST_ENTRIES = 200;

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const READ_ONLY_TOOLS: readonly ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List the files and folders in a folder of the project (relative path, '.' for the root).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative folder path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: `Read a text file of the project (relative path). At most ${String(MAX_READ_BYTES)} bytes.`,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative file path" } },
        required: ["path"],
      },
    },
  },
];

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  READ_ONLY_TOOLS.map((t) => t.function.name),
);

export interface ToolOutcome {
  ok: boolean;
  /** Text handed back to the model (and recorded as the tool result). */
  content: string;
}

const refuse = (content: string): ToolOutcome => ({ ok: false, content });

/** Names that commonly hold secrets: never read, whatever the folder. */
const DENIED_NAME =
  /^(\.env($|\.)|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|pfx|p12|kdbx)$|\.npmrc$|\.netrc$)/i;
const DENIED_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);

const deniedPath = (rel: string): boolean => {
  const parts = rel.split(sep).filter(Boolean);
  return parts.some(
    (p, i) => DENIED_DIRS.has(p.toLowerCase()) || (i === parts.length - 1 && DENIED_NAME.test(p)),
  );
};

/** Resolves `requested` inside `cwd`; returns the real absolute path and the path relative to the real root. */
function confine(cwd: string, requested: unknown): { abs: string; rel: string } | string {
  if (typeof requested !== "string" || requested === "" || requested.includes("\0")) {
    return "path must be a non-empty relative path";
  }
  if (isAbsolute(requested)) return "absolute paths are not allowed";
  let root: string;
  let abs: string;
  try {
    root = realpathSync(cwd);
    abs = realpathSync(resolve(root, requested));
  } catch {
    return "no such file or folder";
  }
  const rel = relative(root, abs);
  // A name like "..notes" is inside the root; only a real ".." segment leaves it.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return "path leaves the project folder";
  }
  if (deniedPath(rel)) return "this path is not readable (it may hold secrets)";
  return { abs, rel };
}

function listDir(cwd: string, args: unknown): ToolOutcome {
  const c = confine(cwd, (args as { path?: unknown } | null)?.path);
  if (typeof c === "string") return refuse(c);
  let entries;
  try {
    entries = readdirSync(c.abs, { withFileTypes: true });
  } catch {
    return refuse("not a folder");
  }
  const names = entries
    .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
    .sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, MAX_LIST_ENTRIES);
  const more = names.length - shown.length;
  return { ok: true, content: shown.join("\n") + (more > 0 ? `\n… ${String(more)} more` : "") };
}

function readFile(cwd: string, args: unknown): ToolOutcome {
  const c = confine(cwd, (args as { path?: unknown } | null)?.path);
  if (typeof c === "string") return refuse(c);
  let fd: number;
  try {
    fd = openSync(c.abs, "r");
  } catch {
    return refuse("cannot open the file");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return refuse("not a regular file");
    // Another name for the same file may live outside the project; realpath cannot see hard links.
    if (st.nlink > 1) return refuse("files with several hard links are not readable");
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES));
    const n = buf.length === 0 ? 0 : readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n);
    if (head.includes(0)) return refuse("binary file");
    const text = head.toString("utf8");
    return {
      ok: true,
      content:
        st.size > MAX_READ_BYTES ? `${text}\n… truncated at ${String(MAX_READ_BYTES)} bytes` : text,
    };
  } finally {
    closeSync(fd);
  }
}

/** Runs one whitelisted tool. Any other name is refused and nothing is executed. */
export function runReadOnlyTool(name: string, args: unknown, cwd: string): ToolOutcome {
  if (!READ_ONLY_TOOL_NAMES.has(name)) return refuse(`unknown tool "${name.slice(0, 40)}"`);
  try {
    return name === "list_dir" ? listDir(cwd, args) : readFile(cwd, args);
  } catch {
    return refuse("the tool failed");
  }
}
