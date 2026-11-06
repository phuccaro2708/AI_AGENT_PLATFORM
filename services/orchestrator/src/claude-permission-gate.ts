import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * NOT verified: that these flags work together with `--safe-mode` (the adapter's default), claude versions other
 * than 2.1.318, and a full run with a real claude. It is opt-in for that reason.
 */
export const GATE_SERVER_NAME = "gate";
export const GATE_TOOL_NAME = "approve";

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");

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
}): (task: AgentTask) => string[] {
  return (task) => {
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
    ];
  };
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
