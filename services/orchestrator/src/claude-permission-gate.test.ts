import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentTask } from "@agent-studio/agent-core";
import { ClaudeAdapter } from "@agent-studio/adapter-claude";
import {
  claudeGateTaskArgs,
  decodePolicy,
  encodePolicy,
  runPermissionGate,
} from "./claude-permission-gate.js";

/** P4-1 d: the permission-prompt MCP server and the flags that point claude at it. No real claude is run. */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "as-gate-")));
  dirs.push(d);
  return d;
}

const task = (cwd: string, over: Partial<AgentTask> = {}): AgentTask => ({
  id: "t-1",
  prompt: "p",
  cwd,
  signal: new AbortController().signal,
  ...over,
});

/** Runs the gate on `lines` and returns its reply lines (the gate ends when its input ends). */
async function converse(cwd: string, lines: unknown[], permissions?: "read-only") {
  const policy = encodePolicy({
    level: permissions === "read-only" ? "read_only" : "workspace_write",
    workspaceRoot: cwd,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const done = runPermissionGate(["--permission-gate", "--policy", policy], input, output);
  for (const l of lines) input.write(`${JSON.stringify(l)}\n`);
  input.end();
  await done;
  return chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
}
const call = (id: number, tool_name: string, input: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "approve", arguments: { tool_name, input, tool_use_id: `u${id}` } },
});
const behavior = (r: { result: Record<string, unknown> }): string =>
  (JSON.parse((r.result["content"] as { text: string }[])[0]!.text) as { behavior: string })
    .behavior;

describe("claudeGateTaskArgs", () => {
  it("askEveryTool is OFF by default and, when on, only appends --settings with permissions.ask", () => {
    const base = { configDir: join(tmp(), "gate"), launcher: { command: "node", args: ["/b.js"] } };
    const off = claudeGateTaskArgs(base)(task(tmp()));
    expect(off).not.toContain("--settings");
    const on = claudeGateTaskArgs({ ...base, askEveryTool: true })(task(tmp()));
    expect(on.slice(0, off.length)).toEqual(off.map((a, i) => (i === 1 ? on[1] : a)));
    const at = on.indexOf("--settings");
    expect(JSON.parse(on[at + 1]!)).toEqual({
      permissions: { ask: ["Write", "Edit", "Read", "Glob", "Grep", "Bash"] },
    });
  });

  it("writes one MCP config per task and names the trio of flags the probe used", () => {
    const cwd = tmp();
    const configDir = join(tmp(), "gate");
    const args = claudeGateTaskArgs({
      configDir,
      launcher: { command: "node", args: ["/bundle.js"] },
    })(task(cwd, { id: "t/../x" }));
    expect(args.slice(2)).toEqual([
      "--strict-mcp-config",
      "--permission-prompt-tool",
      "mcp__gate__approve",
    ]);
    expect(args[0]).toBe("--mcp-config");
    expect(args[1]!.startsWith(configDir)).toBe(true); // a hostile id cannot leave the folder
    const cfg = JSON.parse(readFileSync(args[1]!, "utf8")) as {
      mcpServers: { gate: { command: string; args: string[] } };
    };
    const gate = cfg.mcpServers.gate;
    expect(gate.command).toBe("node");
    expect(gate.args.slice(0, 3)).toEqual(["/bundle.js", "--permission-gate", "--policy"]);
    expect(decodePolicy(gate.args[3]!)).toMatchObject({
      level: "workspace_write",
      workspaceRoot: cwd,
    });
  });

  it("shows up in the claude command line (describeLaunch) after the other flags", () => {
    const cwd = tmp();
    const adapter = new ClaudeAdapter({
      taskArgs: claudeGateTaskArgs({
        configDir: join(tmp(), "gate"),
        launcher: { command: "node", args: ["/b.js"] },
      }),
    });
    const { args } = adapter.describeLaunch(task(cwd, { permissions: "read-only" }));
    expect(args).toContain("--permission-prompt-tool");
    expect(args.indexOf("--tools")).toBeLessThan(args.indexOf("--permission-prompt-tool"));
  });
});

describe("decodePolicy", () => {
  it("rejects garbage, an unknown level and a missing root", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    expect(() => decodePolicy("")).toThrow();
    expect(() => decodePolicy("not base64 json")).toThrow();
    expect(() => decodePolicy(enc({ level: "god", workspaceRoot: "/w" }))).toThrow();
    expect(() => decodePolicy(enc({ level: "read_only" }))).toThrow();
    expect(() => decodePolicy(enc(null))).toThrow();
  });

  it("never carries a command allow list over from the argument", () => {
    const p = decodePolicy(
      Buffer.from(
        JSON.stringify({
          level: "privileged",
          workspaceRoot: "/w",
          commands: { allow: [{ executable: "rm" }] },
        }),
      ).toString("base64url"),
    );
    expect(p.commands?.allow).toEqual([]);
  });
});

describe("runPermissionGate (the MCP server claude would start)", () => {
  it("allows a Write inside the folder, denies one outside, denies Bash and unknown tools", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "sub"));
    const outside = join(tmp(), "evil.txt");
    const replies = await converse(cwd, [
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      call(2, "Write", { file_path: join(cwd, "sub", "ok.txt"), content: "x" }),
      call(3, "Write", { file_path: outside, content: "x" }),
      call(4, "Write", { file_path: join(cwd, ".git", "config"), content: "x" }),
      call(5, "Bash", { command: "git status" }),
      call(6, "WebFetch", { url: "http://example.com" }),
    ]);
    expect(replies.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6]); // in order; none for the notification
    expect(replies.slice(2).map(behavior)).toEqual(["allow", "deny", "deny", "deny", "deny"]);
  });

  it("denies every Write on a read-only policy", async () => {
    const cwd = tmp();
    const replies = await converse(
      cwd,
      [call(1, "Write", { file_path: join(cwd, "a.txt"), content: "x" })],
      "read-only",
    );
    expect(replies.map(behavior)).toEqual(["deny"]);
  });

  it("Edit: allowed in the folder like Write; denied outside, in .git, on read-only and on a wrong shape", async () => {
    const cwd = tmp();
    const outside = join(tmp(), "evil.txt");
    const e = (file_path: unknown, extra: Record<string, unknown> = {}) => ({
      file_path,
      old_string: "a",
      new_string: "b",
      ...extra,
    });
    const replies = await converse(cwd, [
      call(1, "Edit", e(join(cwd, "ok.txt"))),
      call(2, "Edit", e(join(cwd, "ok.txt"), { replace_all: true })),
      call(3, "Edit", e(outside)),
      call(4, "Edit", e(join(cwd, ".git", "config"))),
      call(5, "Edit", e("relative.txt")),
      call(6, "Edit", { file_path: join(cwd, "ok.txt") }), // no strings
      call(7, "Edit", e(join(cwd, "ok.txt"), { replace_all: "yes" })),
      call(8, "Edit", e(42)),
      call(9, "Edit", "not an object"),
    ]);
    expect(replies.map(behavior)).toEqual([
      "allow",
      "allow",
      "deny",
      "deny",
      "deny",
      "deny",
      "deny",
      "deny",
      "deny",
    ]);
    const ro = await converse(cwd, [call(1, "Edit", e(join(cwd, "ok.txt")))], "read-only");
    expect(ro.map(behavior)).toEqual(["deny"]);
  });

  it.each(["Glob", "Grep"])(
    "%s: read policy; allowed in the folder (also without path), denied outside, with escaping globs and on a wrong shape",
    async (tool) => {
      const cwd = tmp();
      mkdirSync(join(cwd, "sub"));
      const outside = tmp();
      const pat = { pattern: tool === "Glob" ? "**/*.txt" : "SEED" };
      // Grep's file filter is `glob`; Glob's own pattern is the glob, so its escape is tried via `pattern`.
      const escape = (g: string) =>
        tool === "Glob" ? { pattern: g, path: cwd } : { ...pat, glob: g, path: cwd };
      const replies = await converse(cwd, [
        call(1, tool, { ...pat, path: join(cwd, "sub") }),
        call(2, tool, pat), // no path → the task folder
        call(3, tool, { ...pat, path: cwd }),
        call(4, tool, { ...pat, path: outside }),
        call(5, tool, { ...pat, path: join(cwd, "..") }),
        call(6, tool, { ...pat, path: "relative" }),
        call(7, tool, { ...pat, path: 7 }),
        call(8, tool, { ...pat, path: "" }),
        call(9, tool, escape("../**/*.txt")),
        call(10, tool, escape("sub/../../x")),
        call(11, tool, escape(join(outside, "*.txt"))),
        call(12, tool, escape("/etc/*")),
        call(13, tool, escape("C:\\Users\\*")),
        call(14, tool, escape("~/*")),
        call(19, tool, escape("{..,a}/{..,a}/x")),
        call(20, tool, escape("{/etc,a}/passwd")),
        call(21, tool, escape("@(..|a)/x")),
        call(22, tool, escape("[.][.]/x")),
        call(15, tool, {}),
        call(16, tool, { pattern: 5 }),
        call(17, tool, { pattern: "" }),
        call(18, tool, "not an object"),
      ]);
      expect(replies.map(behavior)).toEqual([
        "allow",
        "allow",
        "allow",
        ...Array<string>(19).fill("deny"),
      ]);
    },
  );

  it("Grep: a non-string glob is denied; read-only policy still allows Glob/Grep (reads)", async () => {
    const cwd = tmp();
    const replies = await converse(
      cwd,
      [
        call(1, "Grep", { pattern: "x", path: cwd, glob: ["*.ts"] }),
        call(2, "Grep", { pattern: "x", path: cwd, glob: "*.ts" }),
        call(3, "Glob", { pattern: "*.ts", path: cwd }),
      ],
      "read-only",
    );
    expect(replies.map(behavior)).toEqual(["deny", "allow", "allow"]);
  });

  it("refuses to start on a bad policy", async () => {
    await expect(
      runPermissionGate(["--policy", "###"], new PassThrough(), new PassThrough()),
    ).rejects.toThrow();
  });
});
