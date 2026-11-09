import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentTask } from "@agent-studio/agent-core";
import { createPermissionPromptServer } from "@agent-studio/adapter-claude";
import { evaluate, PERMISSION_LEVELS, type Policy } from "@agent-studio/policy-engine";
import { appServerPolicy } from "./codex-app-server-gate.js";

/**
 * P4-1 d, host side: `claude --permission-prompt-tool mcp__gate__approve` makes claude spawn an MCP server and ask
 * it about tool calls its own rules did not settle. The server here is THIS program started with
 * `--permission-gate --policy <base64url JSON>` (see `runPermissionGate`), so no extra file has to be installed.
 *
 * Only data that the 2026-11-05 probe showed is used: `mcpServers.<name>.{command,args}` in the config file and
 * the flag trio below. The policy travels in argv, not in an env var, because env entries of an MCP server were not
 * probed. Policy: `appServerPolicy` (no command allowed; writes only inside the task's cwd).
 *
 * `--safe-mode` and the gate DO NOT work together (d3: the MCP server is not loaded). The sidecar therefore turns
 * `--safe-mode` off whenever the gate is on and refuses a task whose stored arguments bring it back (`sidecar.ts`).
 * Default ON since Q3 (2026-11-07); switch: `AGENT_STUDIO_CLAUDE_GATE=0` / `claudePermissionGate: false`.
 * NOT verified: claude versions other than 2.1.318. Not a sandbox: claude does not send every call to the gate.
 */
export const GATE_SERVER_NAME = "gate";
export const GATE_TOOL_NAME = "approve";

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** Tools whose calls `askEveryTool` forces through the gate. Anything else claude has is NOT covered. */
export const ASK_EVERY_TOOL_RULES: readonly string[] = [
  "Write",
  "Edit",
  "Read",
  "Glob",
  "Grep",
  "Bash",
];

export function encodePolicy(policy: Policy): string {
  return Buffer.from(JSON.stringify(policy), "utf8").toString("base64url");
}

/** Throws on anything that is not a policy this gate understands (the process then exits; claude sees a dead server). */
export function decodePolicy(text: string): Policy {
  const v: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  if (typeof v !== "object" || v === null) throw new Error("policy is not an object");
  const p = v as Record<string, unknown>;
  const level = PERMISSION_LEVELS.find((l) => l === p["level"]);
  if (!level) throw new Error("unknown permission level");
  if (typeof p["workspaceRoot"] !== "string" || p["workspaceRoot"] === "") {
    throw new Error("workspaceRoot missing");
  }
  return { level, workspaceRoot: p["workspaceRoot"], commands: { allow: [] } };
}

export interface ClaudeGateLauncher {
  /** Program claude starts as the MCP server. */
  command: string;
  /** Its leading arguments (for the sidecar: the bundle path); `--permission-gate --policy …` is appended. */
  args: readonly string[];
}

/** `ClaudeAdapterOptions.taskArgs` for the gate: writes `<configDir>/<taskId>.mcp.json` and names it. */
export function claudeGateTaskArgs(o: {
  configDir: string;
  launcher: ClaudeGateLauncher;
  /**
   * R2, opt-in, default OFF: also pass `--settings` with `permissions.ask` for every tool in `ASK_EVERY_TOOL_RULES`,
   * which in the 2026-11-06 probe (claude 2.1.318) routed ALL calls of those tools to the gate (Read, Glob, Grep,
   * `echo`, `git status`, Write in cwd, also under `acceptEdits` and `--allowedTools`). Only effective when claude is
   * ALSO limited to those tools (`--tools`): a tool not listed here is not covered. Not a sandbox.
   */
  askEveryTool?: boolean;
  /**
   * Also pass `--setting-sources local`. The gate needs `--safe-mode` OFF (d3: with it the MCP gate is not loaded
   * and claude exits 1), and this is the configuration isolation that was measured together with the gate (d6):
   * the user's own hooks/plugins are not read from user or project settings. Not a sandbox.
   */
  isolateSettings?: boolean;
  /**
   * Fail closed: throws (the policy gate turns that into a refused task) when the program claude would start as the
   * MCP server cannot be found, instead of launching claude with a gate that is not there.
   */
  requireLauncher?: boolean;
}): (task: AgentTask) => string[] {
  return (task) => {
    if (o.requireLauncher) assertLauncherUsable(o.launcher);
    if (o.isolateSettings) assertSafeLocalSettings(task.cwd);
    const policy = appServerPolicy({
      taskId: task.id,
      cwd: task.cwd,
      permissions: task.permissions,
    });
    const file = join(o.configDir, `${safeName(task.id)}.mcp.json`);
    mkdirSync(o.configDir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          [GATE_SERVER_NAME]: {
            command: o.launcher.command,
            args: [...o.launcher.args, "--permission-gate", "--policy", encodePolicy(policy)],
          },
        },
      }),
    );
    return [
      "--mcp-config",
      file,
      "--strict-mcp-config",
      "--permission-prompt-tool",
      `mcp__${GATE_SERVER_NAME}__${GATE_TOOL_NAME}`,
      // ONE `--settings` object (two flags were never measured): `ask` for askEveryTool, and `disableAllHooks` when
      // the settings are isolated, because the 2026-11-07 probe showed a PreToolUse hook from the task folder's
      // `.claude/settings.local.json` (still read under `--setting-sources local`) RUNS a command outside the gate.
      ...(o.askEveryTool || o.isolateSettings
        ? [
            "--settings",
            JSON.stringify({
              ...(o.askEveryTool ? { permissions: { ask: [...ASK_EVERY_TOOL_RULES] } } : {}),
              ...(o.isolateSettings ? { disableAllHooks: true } : {}),
            }),
          ]
        : []),
      // `ask` only covers what claude can use: with no `permissions` on the task the adapter adds no `--tools`
      // (the measured d6 configuration did), so limit it here. When the task has `permissions`, the adapter
      // already passed its own `--tools`; a second flag is never emitted (duplicate behaviour was not measured).
      ...(o.askEveryTool && task.permissions === undefined
        ? ["--tools", ASK_EVERY_TOOL_RULES.join(",")]
        : []),
      ...(o.isolateSettings ? ["--setting-sources", "local"] : []),
    ];
  };
}

/**
 * Keys of `<cwd>/.claude/settings.local.json` that are accepted under the gate. Everything else is refused: a
 * 2026-11-07 review reproduced with real claude that `env.NODE_OPTIONS` (a Node preload) and `apiKeyHelper` (a
 * program run to fetch the key) execute BEFORE any tool call reaches the gate, and `disableAllHooks` only stops
 * hooks. `permissions` is allowed because `defaultMode`/allow rules were measured NOT to bypass the gate (d11).
 */
export const SAFE_LOCAL_SETTINGS_KEYS: readonly string[] = ["$schema", "model", "permissions"];

/**
 * Fail closed: throws when the task folder's `.claude/settings.local.json` is unreadable, not a JSON object, or has a
 * key outside `SAFE_LOCAL_SETTINGS_KEYS`. The message names the keys, never their values. Only this one file is
 * checked (the one `--setting-sources local` still loads); the user's own settings are not read under that flag.
 */
export function assertSafeLocalSettings(cwd: string): void {
  const file = join(cwd, ".claude", "settings.local.json");
  if (!existsSync(file)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(".claude/settings.local.json in the task folder cannot be read as JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(".claude/settings.local.json in the task folder is not a JSON object");
  }
  const bad = Object.keys(parsed).filter((k) => !SAFE_LOCAL_SETTINGS_KEYS.includes(k));
  if (bad.length > 0) {
    throw new Error(
      `.claude/settings.local.json in the task folder has settings that can run code outside the gate: ${bad.join(", ")}`,
    );
  }
}

/** Absolute paths among the launcher's program and first argument must exist (a missing bundle = no gate = no task). */
function assertLauncherUsable(l: ClaudeGateLauncher): void {
  const first = l.args[0];
  if (first === undefined || first === "")
    throw new Error("permission gate launcher has no script");
  for (const p of [l.command, first]) {
    if (isAbsolute(p) && !existsSync(p)) {
      throw new Error("permission gate launcher not found");
    }
  }
  if (!isAbsolute(first))
    throw new Error("permission gate launcher script is not an absolute path");
}

/** The MCP server loop: one JSON request per line in, one reply line out. Resolves when stdin ends. */
export async function runPermissionGate(
  argv: readonly string[],
  input: Readable,
  output: Writable,
): Promise<void> {
  const at = argv.indexOf("--policy");
  const policy = decodePolicy(at >= 0 ? (argv[at + 1] ?? "") : "");
  const server = createPermissionPromptServer({
    toolName: GATE_TOOL_NAME,
    defaultDir: policy.workspaceRoot,
    evaluate: async (request) => {
      const d = await evaluate(policy, request);
      return { effect: d.effect, reason: d.reason };
    },
  });
  // Replies keep the order of requests: each line is handled after the previous one has been answered.
  let chain: Promise<void> = Promise.resolve();
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    chain = chain.then(async () => {
      const reply = await server.handleLine(line);
      if (reply !== undefined) output.write(`${reply}\n`);
    });
  });
  await new Promise<void>((resolve) => rl.once("close", resolve));
  await chain;
}
