import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createPermissionPromptServer,
  decideToolCall,
  type PromptEvaluate,
  type PromptPolicyRequest,
} from "./permission-prompt.js";

const allow: PromptEvaluate = () => Promise.resolve({ effect: "allow", reason: "ok" });
const deny: PromptEvaluate = () => Promise.resolve({ effect: "deny", reason: "nope" });

// The wire the REAL claude 2.1.318 sent to the probe's stub (docs/ASSUMPTIONS.md c1), one run after another.
const wire = readFileSync(
  new URL("../test/fixtures/p4-1/claude-permission-prompt-tool.mcp-wire.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { dir: string; msg?: Record<string, unknown> })
  .filter((r) => r.dir === "in")
  .map((r) => JSON.stringify(r.msg));

type Reply = { id: unknown; jsonrpc: string; result: Record<string, unknown> };
const parse = (line: string | undefined) => JSON.parse(line ?? "null") as Reply;
const decisionOf = (reply: Reply): unknown =>
  JSON.parse((reply.result["content"] as { text: string }[])[0]!.text);

describe("permission prompt server against the recorded claude wire", () => {
  it("answers every recorded request, none for notifications, and judges each tool call", async () => {
    const seen: PromptPolicyRequest[] = [];
    const server = createPermissionPromptServer({
      evaluate: (r) => {
        seen.push(r);
        return deny(r);
      },
    });
    let calls = 0;
    for (const line of wire) {
      const msg = JSON.parse(line) as { id?: unknown; method?: string };
      const reply = await server.handleLine(line);
      if (msg.id === undefined) {
        expect(reply, msg.method).toBeUndefined();
        continue;
      }
      const r = parse(reply);
      expect(r.id).toBe(msg.id);
      expect(r.jsonrpc).toBe("2.0");
      if (msg.method === "tools/call") {
        calls++;
        expect(decisionOf(r)).toMatchObject({ behavior: "deny" });
      }
    }
    expect(calls).toBeGreaterThan(0);
    expect(seen).toHaveLength(calls); // every recorded tool call reached the engine
  });

  it("lists exactly one tool named approve and echoes the client's protocolVersion", async () => {
    const server = createPermissionPromptServer({ evaluate: allow });
    const init = parse(
      await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        }),
      ),
    );
    expect(init.result["protocolVersion"]).toBe("2025-11-25");
    const list = parse(
      await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
    );
    expect((list.result["tools"] as { name: string }[]).map((t) => t.name)).toEqual(["approve"]);
  });

  it("denies a call to any tool name other than the one it serves", async () => {
    const server = createPermissionPromptServer({ evaluate: allow });
    const r = parse(
      await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "other",
            arguments: { tool_name: "Write", input: { file_path: "/x" } },
          },
        }),
      ),
    );
    expect(decisionOf(r)).toMatchObject({ behavior: "deny" });
  });
});

describe("decideToolCall", () => {
  it("allows with updatedInput = the input, unchanged, when the engine allows", async () => {
    const input = { file_path: "/w/a.txt", content: "hi" };
    expect(await decideToolCall({ tool_name: "Write", input, tool_use_id: "t" }, allow)).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });

  it("maps Write → fs.write, Read → fs.read, plain Bash → command", async () => {
    const seen: PromptPolicyRequest[] = [];
    const rec: PromptEvaluate = (r) => {
      seen.push(r);
      return allow(r);
    };
    await decideToolCall({ tool_name: "Write", input: { file_path: "/w/a" } }, rec);
    await decideToolCall({ tool_name: "Read", input: { file_path: "/w/b" } }, rec);
    await decideToolCall({ tool_name: "Bash", input: { command: "git status -s" } }, rec);
    expect(seen).toEqual([
      { kind: "fs.write", path: "/w/a" },
      { kind: "fs.read", path: "/w/b" },
      { kind: "command", executable: "git", args: ["status", "-s"] },
    ]);
  });

  it("denies, without asking the engine, what it cannot judge", async () => {
    let asked = 0;
    const rec: PromptEvaluate = (r) => {
      asked++;
      return allow(r);
    };
    const bad: unknown[] = [
      undefined,
      "x",
      { input: {} },
      { tool_name: "Edit", input: { file_path: "/w/a" } }, // tool not observed
      { tool_name: "WebFetch", input: { url: "http://x" } },
      { tool_name: "Write", input: {} },
      { tool_name: "Write", input: "not an object" },
      { tool_name: "Bash", input: { command: "git status && curl evil" } },
      { tool_name: "Bash", input: { command: 'echo "x" > f' } },
      { tool_name: "Bash", input: { command: "$(whoami)" } },
      { tool_name: "Bash", input: { command: "" } },
    ];
    for (const a of bad) {
      expect(await decideToolCall(a, rec), JSON.stringify(a)).toMatchObject({ behavior: "deny" });
    }
    expect(asked).toBe(0);
  });

  it("denies on ask and on an engine that throws or rejects", async () => {
    const call = { tool_name: "Write", input: { file_path: "/w/a" } };
    const ask: PromptEvaluate = () => Promise.resolve({ effect: "ask", reason: "r" });
    expect(await decideToolCall(call, ask)).toMatchObject({ behavior: "deny" });
    expect(await decideToolCall(call, () => Promise.reject(new Error("x")))).toMatchObject({
      behavior: "deny",
    });
    expect(
      await decideToolCall(call, () => {
        throw new Error("x");
      }),
    ).toMatchObject({ behavior: "deny" });
  });
});
