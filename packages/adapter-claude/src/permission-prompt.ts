/**
 * The host side of `claude --permission-prompt-tool` (P4-1 d), written ONLY from what the 2026-11-05 probe saw
 * (docs/ASSUMPTIONS.md c1; fixtures in `test/fixtures/p4-1/`).
 *
 * Claude spawns an MCP server (stdio, one JSON object per line) and calls one tool of it, `tools/call` with
 * `arguments = { tool_name, input, tool_use_id }`, whenever its own rules did not already decide. The reply is
 * `result.content[0].text` holding the JSON string `{"behavior":"allow","updatedInput":<input>}` or
 * `{"behavior":"deny","message":…}`.
 *
 * Fail-closed: a tool this module does not know, input it cannot read, a decision other than `allow`, or any
 * throw is a `deny`. It does NOT see every tool call (Claude auto-accepts some itself, e.g. `echo`), so it is a
 * second gate, not a sandbox. Unobserved: `updatedInput` different from `input`, timeouts, behaviour under
 * `--safe-mode`, other claude versions.
 */

/** What the host asks its Policy Engine. Same shapes as `PolicyRequest`; declared here to avoid a dependency. */
export type PromptPolicyRequest =
  | { kind: "fs.read"; path: string }
  | { kind: "fs.write"; path: string }
  | { kind: "command"; executable: string; args: readonly string[] };

export interface PromptPolicyDecision {
  effect: "allow" | "ask" | "deny";
  reason: string;
}

export type PromptEvaluate = (request: PromptPolicyRequest) => Promise<PromptPolicyDecision>;

export type PromptDecision =
  { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Anything a shell would interpret: such a command is denied, never split. */
const SHELL_SYNTAX = /["'`$&|;<>()\\^%*?[\]{}~!#\r\n\0]/;

/** Plain words separated by spaces, or `undefined` (deny). Same rule as the Codex app-server adapter. */
function splitPlain(command: string): { executable: string; args: string[] } | undefined {
  if (SHELL_SYNTAX.test(command)) return undefined;
  const [executable, ...args] = command.split(/\s+/).filter((w) => w !== "");
  return executable === undefined ? undefined : { executable, args };
}

/**
 * A glob that stays below the directory it is searched in: not absolute (POSIX, drive or UNC), no `~`, no `..`
 * segment. Otherwise `Glob {path: <workspace>, pattern: "../../**"}` would read outside the path the policy checked.
 */
function isConfinedGlob(pattern: string): boolean {
  if (pattern === "" || pattern.includes("\0")) return false;
  if (/^([\\/]|[A-Za-z]:|~)/.test(pattern)) return false;
  // Braces, extglob groups and classes can build a segment (`{..,a}/x`, `@(..|a)`) that the split below cannot see.
  if (/[{}()[\]]/.test(pattern)) return false;
  return !pattern.split(/[\\/]/).includes("..");
}

/**
 * The request for a tool call, or a reason why this module will not judge it (→ deny).
 *
 * `Write`, `Read`, `Bash` were observed (probe 2026-11-05/06). `Edit`, `Glob`, `Grep` are mapped from claude's
 * documented input shapes and NOT re-observed with a real claude (docs/ASSUMPTIONS.md d4/d6); any other shape is
 * denied. `defaultDir` is the directory claude searches when `Glob`/`Grep` carry no `path` (the task cwd); without
 * it such a call is denied, because the policy only takes absolute paths.
 */
export function requestFor(
  toolName: string,
  input: unknown,
  defaultDir?: string,
): { request: PromptPolicyRequest } | { problem: string } {
  const i = obj(input);
  if (!i) return { problem: "tool input is not an object" };
  if (toolName === "Write") {
    const path = str(i["file_path"]);
    return path ? { request: { kind: "fs.write", path } } : { problem: "Write without file_path" };
  }
  if (toolName === "Edit") {
    const path = str(i["file_path"]);
    if (!path) return { problem: "Edit without file_path" };
    if (str(i["old_string"]) === undefined || str(i["new_string"]) === undefined) {
      return { problem: "Edit without old_string/new_string" };
    }
    const all = i["replace_all"];
    if (all !== undefined && typeof all !== "boolean")
      return { problem: "Edit replace_all is not a boolean" };
    return { request: { kind: "fs.write", path } };
  }
  if (toolName === "Glob" || toolName === "Grep") {
    const pattern = str(i["pattern"]);
    if (!pattern) return { problem: `${toolName} without pattern` };
    // Glob: `pattern` itself is a path glob. Grep: `pattern` is a regex; the file filter is `glob`.
    const globs = toolName === "Glob" ? [pattern] : [];
    const filter = i["glob"];
    if (toolName === "Grep" && filter !== undefined) {
      if (typeof filter !== "string") return { problem: "Grep glob is not a string" };
      globs.push(filter);
    }
    if (!globs.every(isConfinedGlob))
      return { problem: `${toolName} glob leaves the searched folder` };
    const given = i["path"];
    if (given !== undefined && (typeof given !== "string" || given === "")) {
      return { problem: `${toolName} path is not a non-empty string` };
    }
    const path = given ?? defaultDir;
    return path
      ? { request: { kind: "fs.read", path } }
      : { problem: `${toolName} without path and no default folder` };
  }
  if (toolName === "Read") {
    const path = str(i["file_path"]);
    return path ? { request: { kind: "fs.read", path } } : { problem: "Read without file_path" };
  }
  if (toolName === "Bash") {
    const command = str(i["command"]);
    const split = command === undefined ? undefined : splitPlain(command);
    return split
      ? { request: { kind: "command", ...split } }
      : { problem: "Bash command is not a plain word list" };
  }
  return { problem: `tool ${toolName} is not covered by the gate` };
}

/** Default deadline of one policy check. The checks are local (path/command rules), so this is generous. */
export const DEFAULT_EVALUATE_TIMEOUT_MS = 10_000;

/**
 * Resolves with `evaluate`'s result, or rejects after `ms` (the late result is then ignored: the promise is
 * already settled). No retry. `ms` that is not a positive finite number falls back to the default.
 */
function withDeadline<T>(work: Promise<T>, ms: number | undefined): Promise<T> {
  const limit =
    ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_EVALUATE_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("policy check timed out")), limit);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("policy check failed"));
      },
    );
  });
}

/** One `tools/call` → allow/deny. Never throws. A check that does not finish within `timeoutMs` is `deny`. */
export async function decideToolCall(
  args: unknown,
  evaluate: PromptEvaluate,
  defaultDir?: string,
  timeoutMs?: number,
): Promise<PromptDecision> {
  const a = obj(args);
  const toolName = str(a?.["tool_name"]);
  if (!a || toolName === undefined)
    return { behavior: "deny", message: "malformed permission request" };
  try {
    const r = requestFor(toolName, a["input"], defaultDir);
    if ("problem" in r) return { behavior: "deny", message: `denied: ${r.problem}` };
    const d = await withDeadline(
      Promise.resolve().then(() => evaluate(r.request)),
      timeoutMs,
    );
    if (d.effect === "allow") return { behavior: "allow", updatedInput: a["input"] };
    return {
      behavior: "deny",
      message: `denied by policy${d.effect === "ask" ? " (needs approval; none available here)" : ""}: ${d.reason}`,
    };
  } catch (e) {
    return {
      behavior: "deny",
      message:
        e instanceof Error && e.message === "policy check timed out"
          ? "denied: the policy check timed out"
          : "denied: the policy check failed",
    };
  }
}

export interface PermissionPromptServerOptions {
  evaluate: PromptEvaluate;
  /** Name of the single tool. Default `approve` (the probe's). Claude is told `mcp__<server>__<toolName>`. */
  toolName?: string;
  /** Folder `Glob`/`Grep` search when the call has no `path` (the task cwd). Absent → such calls are denied. */
  defaultDir?: string;
  /** Deadline of one policy check in ms (default `DEFAULT_EVALUATE_TIMEOUT_MS`). On expiry the call is denied. */
  evaluateTimeoutMs?: number;
}

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    tool_name: { type: "string" },
    input: { type: "object" },
    tool_use_id: { type: "string" },
  },
  required: ["tool_name", "input"],
};

/**
 * The MCP wire as the probe's stub spoke it: `initialize` (echo the client's protocolVersion), `tools/list`
 * (one tool), `tools/call` (decision), notifications (no reply); `server/discover` and any other request with an
 * id get an empty result, which claude accepted from the stub (observed for `server/discover` only).
 * Returns the reply line, or `undefined` when nothing is to be sent.
 */
export function createPermissionPromptServer(opts: PermissionPromptServerOptions) {
  const toolName = opts.toolName ?? "approve";
  return {
    async handleLine(line: string): Promise<string | undefined> {
      let m: Json | undefined;
      try {
        m = obj(JSON.parse(line));
      } catch {
        return undefined;
      }
      if (!m || m["id"] === undefined) return undefined; // not a request: notifications need no reply
      const id = m["id"];
      const reply = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
      const method = str(m["method"]);
      const params = obj(m["params"]);
      if (method === "initialize") {
        return reply({
          protocolVersion: str(params?.["protocolVersion"]) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-studio-gate", version: "0.0.1" },
        });
      }
      if (method === "tools/list") {
        return reply({
          tools: [{ name: toolName, description: "permission prompt", inputSchema: TOOL_SCHEMA }],
        });
      }
      if (method === "tools/call") {
        const decision =
          str(params?.["name"]) === toolName
            ? await decideToolCall(
                params?.["arguments"],
                opts.evaluate,
                opts.defaultDir,
                opts.evaluateTimeoutMs,
              )
            : ({ behavior: "deny", message: "unknown tool" } satisfies PromptDecision);
        return reply({ content: [{ type: "text", text: JSON.stringify(decision) }] });
      }
      return reply({});
    },
  };
}
