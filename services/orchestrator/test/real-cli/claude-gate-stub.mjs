// MCP server for `claude --permission-prompt-tool mcp__gate__approve`, used ONLY by the opt-in real-CLI checks
// (src/real-cli-gates.test.ts). It logs every line claude sends and answers `tools/call` in the mode given on argv:
//   node claude-gate-stub.mjs <mode> <logfile> [delayMs]
// modes: allow | deny | rewrite (allow with different content) | redirect (allow, other file in the same dir) |
//        escape (allow, file one directory up) | noinput (allow without updatedInput) | garbage (not a decision) |
//        hang (never answers) | crash (exits on the first tools/call)
import { appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers";

const [mode = "deny", logFile, delay = "0"] = process.argv.slice(2);
const log = (o) => appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const SCHEMA = {
  type: "object",
  properties: {
    tool_name: { type: "string" },
    input: { type: "object" },
    tool_use_id: { type: "string" },
  },
  required: ["tool_name", "input"],
};

log({ dir: "start", mode });
process.on("exit", (code) => log({ dir: "exit", code }));
process.stdin.on("end", () => log({ dir: "stdin-end" }));

function decision(input) {
  const file = typeof input.file_path === "string" ? input.file_path : "";
  switch (mode) {
    case "allow":
      return { behavior: "allow", updatedInput: input };
    case "rewrite":
      return { behavior: "allow", updatedInput: { ...input, content: "REWRITTEN-BY-GATE\n" } };
    case "redirect":
      return {
        behavior: "allow",
        updatedInput: { ...input, file_path: join(dirname(file), `redirected-${basename(file)}`) },
      };
    case "escape":
      return {
        behavior: "allow",
        updatedInput: {
          ...input,
          file_path: join(dirname(dirname(file)), `ESCAPED-${basename(file)}`),
        },
      };
    case "noinput":
      return { behavior: "allow" };
    default:
      return { behavior: "deny", message: "denied by stub" };
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  log({ dir: "in", msg: m });
  if (m.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub", version: "0.0.1" },
      },
    });
  } else if (m.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        tools: [{ name: "approve", description: "permission prompt", inputSchema: SCHEMA }],
      },
    });
  } else if (m.method === "tools/call") {
    if (mode === "hang") return;
    if (mode === "crash") process.exit(3);
    const text =
      mode === "garbage" ? "not json" : JSON.stringify(decision(m.params?.arguments?.input ?? {}));
    log({ dir: "out", text });
    setTimeout(
      () => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } }),
      Number(delay),
    );
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
