import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent, TaskPermissions } from "@agent-studio/contracts";
import { ClaudeAdapter } from "@agent-studio/adapter-claude";
import { CodexAppServerAdapter } from "@agent-studio/adapter-codex";
import { resolveExecutable, unwrapNpmShim } from "@agent-studio/process-manager";
import { evaluate, type Policy } from "@agent-studio/policy-engine";
import { appServerPolicy } from "./codex-app-server-gate.js";
import { claudeGateTaskArgs } from "./claude-permission-gate.js";

/**
 * MANUAL, OPT-IN checks of the two permission gates against the REAL `codex` and `claude` (P4-1 c/d).
 * Skipped unless `AGENT_STUDIO_REAL_CLI_GATES` is set: `1` = both, `codex` or `claude` = one. They spend a few cents of
 * model usage and take minutes. Run:
 *
 *   AGENT_STUDIO_REAL_CLI_GATES=1 pnpm exec vitest run services/orchestrator/src/real-cli-gates.test.ts
 *   (PowerShell: $env:AGENT_STUDIO_REAL_CLI_GATES = "1"; …)
 *
 * Scope (agreed with the user): tiny prompts that carry no project code, secrets or paths; every working directory is
 * a fresh EMPTY git repo under the OS temp dir; no command with side effects outside it; no CLI configuration is
 * changed. Optional: `AGENT_STUDIO_REAL_CLI_GATES_OUT=<dir>` keeps the raw observations (JSON) in that directory.
 * The assertions check SAFETY invariants only (a declined/denied action left no trace); what the model chose to do
 * varies run to run, so the observed protocol facts are written to the report and recorded by hand in
 * docs/ASSUMPTIONS.md (d3), with the CLI versions.
 */

const MODE = process.env["AGENT_STUDIO_REAL_CLI_GATES"] ?? "";
const WANT_CODEX = MODE === "1" || MODE === "codex";
const WANT_CLAUDE = MODE === "1" || MODE === "claude";
const OUT = process.env["AGENT_STUDIO_REAL_CLI_GATES_OUT"];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const tapScript = join(here, "../test/real-cli/codex-tap.mjs");
const stubScript = join(here, "../test/real-cli/claude-gate-stub.mjs");

let scratch: string;
const report: Record<string, unknown> = {};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "real-cli-gates-"));
  if (WANT_CODEX) report["codexVersion"] = version("codex");
  if (WANT_CLAUDE) report["claudeVersion"] = version("claude");
});
afterAll(() => {
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "real-cli-gates.json"), JSON.stringify(report, null, 2));
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function version(cli: string): string {
  try {
    return execFileSync(cli, ["--version"], { encoding: "utf8", shell: false }).trim();
  } catch (e) {
    return `unavailable: ${String(e)}`;
  }
}

/** A fresh empty git repo; returns its path. Its parent is `scratch/<name>` so "outside the repo" is also scratch. */
function freshRepo(name: string): { root: string; repo: string } {
  const root = join(scratch, name);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return { root, repo };
}

const filesIn = (dir: string): string[] => readdirSync(dir).filter((f) => f !== ".git");

// ------------------------------------------------------------------------------------------------------------
// Codex: `codex app-server` behind CodexAppServerAdapter + the orchestrator's policy
// ------------------------------------------------------------------------------------------------------------

interface TapLine {
  dir: "c2s" | "s2c";
  line: string;
}
const parse = (l: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(l);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

interface CodexRun {
  events: AgentEvent[];
  /** Every call the adapter made to the policy, with the verdict. */
  asked: { request: unknown; effect: string; code: string }[];
  traffic: TapLine[];
  /** approval requests the server sent, and the decision we answered, in order */
  approvals: { method: string; params: Record<string, unknown>; answer: unknown }[];
}

async function runCodex(o: {
  name: string;
  prompt: string;
  permissions: TaskPermissions;
  /** Added to the production policy (`appServerPolicy`: no command allowed) so the ACCEPT path can be observed. */
  allowCommands?: string[];
}): Promise<CodexRun & { repo: string; root: string }> {
  const { root, repo } = freshRepo(o.name);
  const logFile = join(root, "tap.jsonl");
  const resolved = resolveExecutable("codex");
  const target = resolved.kind === "shim" ? unwrapNpmShim(resolved) : resolved;
  if (!target) throw new Error("cannot unwrap the codex launcher");
  const asked: CodexRun["asked"] = [];
  const adapter = new CodexAppServerAdapter({
    command: process.execPath,
    baseArgs: [tapScript],
    env: {
      ...process.env,
      CODEX_TAP_LOG: logFile,
      CODEX_TAP_TARGET: JSON.stringify({ path: target.path, prefixArgs: target.prefixArgs ?? [] }),
    },
    envAllow: ["CODEX_TAP_LOG", "CODEX_TAP_TARGET"],
    approvalTimeoutMs: 30_000,
    evaluate: async (request, ctx) => {
      const base = appServerPolicy(ctx);
      const policy: Policy = {
        ...base,
        commands: { allow: (o.allowCommands ?? []).map((executable) => ({ executable })) },
      };
      const d = await evaluate(policy, request, { taskId: ctx.taskId });
      asked.push({ request, effect: d.effect, code: d.code });
      return d;
    },
  });
  const events: AgentEvent[] = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 150_000);
  try {
    for await (const e of adapter.execute({
      id: `real-${o.name}`,
      prompt: o.prompt,
      cwd: repo,
      permissions: o.permissions,
      signal: ac.signal,
    })) {
      events.push(e);
    }
  } finally {
    clearTimeout(timer);
  }
  const traffic: TapLine[] = existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as TapLine)
    : [];
  const approvals: CodexRun["approvals"] = [];
  for (const t of traffic) {
    const m = parse(t.line);
    if (t.dir !== "s2c" || !m || typeof m["method"] !== "string" || m["id"] === undefined) continue;
    if (!/requestApproval$/.test(m["method"])) continue;
    const reply = traffic
      .map((x) => (x.dir === "c2s" ? parse(x.line) : undefined))
      .find((r) => r !== undefined && r["id"] === m["id"] && r["method"] === undefined);
    approvals.push({
      method: m["method"],
      params: (m["params"] ?? {}) as Record<string, unknown>,
      answer: reply?.["result"],
    });
  }
  report[o.name] = {
    events: events.map((e) => JSON.stringify(e).slice(0, 400)),
    asked,
    approvals: approvals.map((a) => ({
      method: a.method,
      command: a.params["command"],
      cwd: a.params["cwd"],
      availableDecisions: a.params["availableDecisions"],
      grantRoot: a.params["grantRoot"],
      answer: a.answer,
    })),
    methods: [...new Set(traffic.map((t) => parse(t.line)?.["method"]).filter(Boolean))],
    filesInRepo: filesIn(repo),
    filesInRoot: filesIn(root),
  };
  return { events, asked, traffic, approvals, repo, root };
}

describe.skipIf(!WANT_CODEX)("REAL codex app-server behind the policy gate", () => {
  it("read-only, production policy (no command allowed): every command is declined and nothing runs", async () => {
    const r = await runCodex({
      name: "codex-readonly-nocmd",
      permissions: "read-only",
      prompt:
        "Run a shell command that lists the files in the current directory, then tell me the names. Use only one simple command.",
    });
    // The tap shows the shape of the real request, and every answer we sent is exactly accept or decline.
    for (const a of r.approvals) {
      expect(["accept", "decline"]).toContain(
        (a.answer as { decision?: string } | undefined)?.decision,
      );
    }
    // Nothing was allowed by the policy, so no command may have been accepted.
    expect(
      r.approvals.filter(
        (a) => (a.answer as { decision?: string } | undefined)?.decision === "accept",
      ),
    ).toEqual([]);
    expect(r.asked.filter((x) => x.effect === "allow")).toEqual([]);
    expect(filesIn(r.root).sort()).toEqual(["repo", "tap.jsonl"]);
  }, 180_000);

  it("read-only, one listing command allowed: the accept path with the real CLI", async () => {
    const r = await runCodex({
      name: "codex-readonly-allow-list",
      permissions: "read-only",
      allowCommands: ["Get-ChildItem", "ls", "dir"],
      prompt:
        "Run exactly the PowerShell command Get-ChildItem in the current directory (no pipes, no extra options) and tell me the output.",
    });
    for (const a of r.approvals) {
      expect(["accept", "decline"]).toContain(
        (a.answer as { decision?: string } | undefined)?.decision,
      );
    }
    expect(filesIn(r.root).sort()).toEqual(["repo", "tap.jsonl"]);
  }, 180_000);

  it("read-only, file creation: the fileChange approval is declined by the policy and the file does not appear", async () => {
    const r = await runCodex({
      name: "codex-readonly-write",
      permissions: "read-only",
      prompt:
        "Create a file named hello.txt containing the word ok. Use the patch tool, not a shell command.",
    });
    expect(r.asked.filter((x) => x.effect === "allow")).toEqual([]);
    expect(filesIn(r.repo)).not.toContain("hello.txt");
    expect(filesIn(r.root).sort()).toEqual(["repo", "tap.jsonl"]);
  }, 180_000);

  it("workspace-write, file creation inside the repo: observe whether a fileChange approval is requested at all", async () => {
    const r = await runCodex({
      name: "codex-workspace-write-write",
      permissions: "workspace-write",
      prompt:
        "Create a file named hello.txt containing the word ok. Use the patch tool, not a shell command.",
    });
    // Whatever happened, nothing may appear outside the repo.
    expect(filesIn(r.root).sort()).toEqual(["repo", "tap.jsonl"]);
    for (const a of r.approvals) {
      expect(["accept", "decline"]).toContain(
        (a.answer as { decision?: string } | undefined)?.decision,
      );
    }
  }, 180_000);
});

// ------------------------------------------------------------------------------------------------------------
// Claude: `--permission-prompt-tool`
// ------------------------------------------------------------------------------------------------------------

type StubMode =
  "allow" | "deny" | "rewrite" | "redirect" | "escape" | "noinput" | "garbage" | "hang" | "crash";

interface StubLine {
  dir: string;
  msg?: {
    method?: string;
    params?: { arguments?: { tool_name?: string; input?: Record<string, unknown> } };
  };
  text?: string;
  code?: number;
}

interface ClaudeStubRun {
  code: number | null;
  timedOut: boolean;
  ms: number;
  root: string;
  repo: string;
  /** `tools/call` requests the stub received: tool name and input */
  calls: { tool: string | undefined; input: Record<string, unknown> | undefined }[];
  starts: number;
  toolResults: { isError: boolean; text: string }[];
  mcpServers: unknown;
  permissionMode: unknown;
  permissionDenials: unknown;
  stderr: string;
}

/** The probe's argv (docs/ASSUMPTIONS.md c1), but with a stub that this test controls. `safe` adds `--safe-mode`. */
async function runClaudeStub(o: {
  name: string;
  mode: StubMode;
  prompt: string;
  safe?: boolean;
  tools?: string;
  permissionMode?: string;
  extra?: string[];
  seed?: Record<string, string>;
  delayMs?: number;
  timeoutMs?: number;
  /** Optional shell-free setup: run before the CLI (e.g. nothing). */
}): Promise<ClaudeStubRun> {
  const { root, repo } = freshRepo(o.name);
  for (const [k, v] of Object.entries(o.seed ?? {})) writeFileSync(join(repo, k), v);
  const log = join(root, "stub.log.jsonl");
  const cfg = join(root, "mcp.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      mcpServers: {
        gate: {
          command: process.execPath,
          args: [stubScript, o.mode, log, String(o.delayMs ?? 0)],
        },
      },
    }),
  );
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "haiku",
    "--no-session-persistence",
    ...(o.safe ? ["--safe-mode"] : ["--setting-sources", "local", "--disable-slash-commands"]),
    "--strict-mcp-config",
    "--mcp-config",
    cfg,
    "--permission-prompt-tool",
    "mcp__gate__approve",
    ...(o.permissionMode ? ["--permission-mode", o.permissionMode] : []),
    ...(o.extra ?? []),
    "--max-budget-usd",
    "0.3",
    `--tools=${o.tools ?? "Write"}`,
  ];
  const started = Date.now();
  const child = spawn("claude", args, { cwd: repo, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  child.stdin.end(o.prompt);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        child.kill();
      }
    }
  }, o.timeoutMs ?? 120_000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);

  const lines = out.split("\n").filter(Boolean).map(parse);
  const toolResults: ClaudeStubRun["toolResults"] = [];
  let mcpServers: unknown;
  let permissionMode: unknown;
  let permissionDenials: unknown;
  for (const m of lines) {
    if (!m) continue;
    if (m["type"] === "system" && m["subtype"] === "init") {
      mcpServers = m["mcp_servers"];
      permissionMode = m["permissionMode"];
    }
    if (m["type"] === "user") {
      const content = (m["message"] as { content?: unknown[] } | undefined)?.content ?? [];
      for (const c of content as Record<string, unknown>[]) {
        if (c["type"] === "tool_result") {
          toolResults.push({
            isError: c["is_error"] === true,
            text: JSON.stringify(c["content"]).slice(0, 300),
          });
        }
      }
    }
    if (m["type"] === "result") permissionDenials = m["permission_denials"];
  }
  const stub: StubLine[] = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as StubLine)
    : [];
  const result: ClaudeStubRun = {
    code,
    timedOut,
    ms: Date.now() - started,
    root,
    repo,
    calls: stub
      .filter((s) => s.dir === "in" && s.msg?.method === "tools/call")
      .map((s) => ({
        tool: s.msg?.params?.arguments?.tool_name,
        input: s.msg?.params?.arguments?.input,
      })),
    starts: stub.filter((s) => s.dir === "start").length,
    toolResults,
    mcpServers,
    permissionMode,
    permissionDenials,
    stderr: err.slice(0, 300),
  };
  report[o.name] = { ...result, filesInRepo: filesIn(repo), filesInRoot: filesIn(root) };
  return result;
}

const WRITE_W = "Create a file named w.txt containing the word ok. Then say done.";
const WRITE_OUTSIDE =
  "Create the file ../outside.txt (one directory above the working directory) containing the word ok, using the Write tool with an absolute path. Then say done.";
const rootExtras = new Set(["repo", "stub.log.jsonl", "mcp.json"]);
const strayFiles = (root: string): string[] => filesIn(root).filter((f) => !rootExtras.has(f));

describe.skipIf(!WANT_CLAUDE)(
  "REAL claude --permission-prompt-tool, controllable stub (d2 open questions)",
  () => {
    it("--safe-mode: the MCP gate is NOT loaded, the permission-prompt tool is 'not found' and the write fails closed", async () => {
      const r = await runClaudeStub({
        name: "claude-safe-mode",
        mode: "allow",
        safe: true,
        prompt: WRITE_W,
      });
      expect(r.calls).toEqual([]);
      expect(r.starts).toBe(0);
      expect(filesIn(r.repo)).not.toContain("w.txt");
    }, 150_000);

    it("allow with updatedInput different from input: claude APPLIES the replacement (content)", async () => {
      const r = await runClaudeStub({
        name: "claude-updatedinput-rewrite",
        mode: "rewrite",
        prompt: WRITE_W,
      });
      expect(r.calls.length).toBeGreaterThan(0);
      const f = join(r.repo, "w.txt");
      if (existsSync(f)) expect(readFileSync(f, "utf8")).toBe("REWRITTEN-BY-GATE\n");
    }, 150_000);

    it("allow with updatedInput pointing OUTSIDE the cwd: claude writes there without re-checking", async () => {
      const r = await runClaudeStub({
        name: "claude-updatedinput-escape",
        mode: "escape",
        prompt: WRITE_W,
      });
      expect(r.calls.length).toBeGreaterThan(0);
      // Recorded, not hidden: this is the observation that makes `updatedInput` untouchable in the host gate.
      report["claude-updatedinput-escape-wrote-outside"] = strayFiles(r.root);
    }, 150_000);

    it("allow without updatedInput: the original input is used", async () => {
      const r = await runClaudeStub({
        name: "claude-allow-noinput",
        mode: "noinput",
        prompt: WRITE_W,
      });
      expect(r.calls.length).toBeGreaterThan(0);
    }, 150_000);

    it("a reply that is not a decision fails closed (tool error, nothing written)", async () => {
      const r = await runClaudeStub({ name: "claude-garbage", mode: "garbage", prompt: WRITE_W });
      expect(r.calls.length).toBeGreaterThan(0);
      expect(filesIn(r.repo)).not.toContain("w.txt");
    }, 150_000);

    it("the gate process dies on the first call: 'Connection closed', nothing written", async () => {
      const r = await runClaudeStub({ name: "claude-gate-crash", mode: "crash", prompt: WRITE_W });
      expect(r.calls.length).toBeGreaterThan(0);
      expect(filesIn(r.repo)).not.toContain("w.txt");
    }, 150_000);

    it("a gate that answers after 20 s: claude waits (no short timeout)", async () => {
      const r = await runClaudeStub({
        name: "claude-gate-slow",
        mode: "allow",
        delayMs: 20_000,
        prompt: WRITE_W,
        timeoutMs: 120_000,
      });
      expect(r.timedOut).toBe(false);
      expect(r.ms).toBeGreaterThanOrEqual(20_000);
    }, 180_000);

    it("a gate that never answers: claude is still waiting after the test's deadline (host must enforce its own)", async () => {
      const r = await runClaudeStub({
        name: "claude-gate-hang",
        mode: "hang",
        prompt: WRITE_W,
        timeoutMs: Number(process.env["AGENT_STUDIO_REAL_CLI_GATES_HANG_MS"] ?? 45_000),
      });
      expect(r.timedOut).toBe(true);
      expect(filesIn(r.repo)).not.toContain("w.txt");
    }, 180_000);

    it("which calls reach the gate: default mode Write → yes; acceptEdits Write in cwd → no; --allowedTools=Write → no; Read in cwd → no; git status → no; Bash with a redirect → yes; Edit → yes", async () => {
      const seed = { "seed.txt": "SEEDVALUE-123" };
      const cases: [string, Parameters<typeof runClaudeStub>[0]][] = [
        ["default-write", { name: "claude-which-default-write", mode: "deny", prompt: WRITE_W }],
        [
          "acceptEdits-write",
          {
            name: "claude-which-acceptedits-write",
            mode: "deny",
            permissionMode: "acceptEdits",
            prompt: WRITE_W,
          },
        ],
        [
          "allowedTools-write",
          {
            name: "claude-which-allowedtools-write",
            mode: "deny",
            extra: ["--allowedTools=Write"],
            prompt: WRITE_W,
          },
        ],
        [
          "read-in-cwd",
          {
            name: "claude-which-read",
            mode: "deny",
            tools: "Read,Grep,Glob",
            seed,
            prompt: "Read the file seed.txt and tell me its content in one line.",
          },
        ],
        [
          "bash-git-status",
          {
            name: "claude-which-bash-git-status",
            mode: "deny",
            tools: "Bash",
            prompt: "Run exactly this shell command and report the output: git status",
          },
        ],
        [
          "bash-redirect",
          {
            name: "claude-which-bash-redirect",
            mode: "deny",
            tools: "Bash",
            prompt: "Run exactly this shell command and report: echo probe > out.txt",
          },
        ],
        [
          "edit",
          {
            name: "claude-which-edit",
            mode: "deny",
            tools: "Edit,Read",
            seed,
            prompt:
              "In seed.txt replace SEEDVALUE with CHANGED using the Edit tool, then say done.",
          },
        ],
      ];
      const reached: Record<string, string[]> = {};
      for (const [label, c] of cases) {
        const r = await runClaudeStub(c);
        reached[label] = r.calls.map((x) => x.tool ?? "?");
        // The stub denies everything, so nothing it was asked about may have taken effect.
        if (label === "bash-redirect") expect(filesIn(r.repo)).not.toContain("out.txt");
        if (label === "edit")
          expect(readFileSync(join(r.repo, "seed.txt"), "utf8")).toBe("SEEDVALUE-123");
        if (label === "default-write") expect(filesIn(r.repo)).not.toContain("w.txt");
      }
      report["claude-which-calls-reach-the-gate"] = reached;
    }, 900_000);

    it("a Write OUTSIDE the cwd is routed to the gate in default mode and in acceptEdits, and a stub that allows it makes it happen", async () => {
      for (const [name, permissionMode] of [
        ["claude-outside-default", undefined],
        ["claude-outside-acceptedits", "acceptEdits"],
      ] as const) {
        const r = await runClaudeStub({
          name,
          mode: "allow",
          ...(permissionMode ? { permissionMode } : {}),
          prompt: WRITE_OUTSIDE,
        });
        report[`${name}-outside-files`] = strayFiles(r.root);
        expect(r.calls.length).toBeGreaterThan(0);
      }
    }, 300_000);
  },
);

describe.skipIf(!WANT_CLAUDE)(
  "REAL claude behind the REAL gate (ClaudeAdapter + claudeGateTaskArgs + bundled sidecar)",
  () => {
    let bundle: string;
    beforeAll(async () => {
      bundle = join(scratch, "sidecar.mjs");
      const mod = (await import(
        pathToFileURL(join(repoRoot, "scripts/sidecar-bundle.mjs")).href
      )) as {
        bundleSidecar: (outfile: string) => Promise<void>;
      };
      await mod.bundleSidecar(bundle);
    }, 120_000);

    async function runAdapter(o: {
      name: string;
      prompt: string;
      permissions: TaskPermissions | undefined;
      safeMode: boolean;
    }) {
      const { root, repo } = freshRepo(o.name);
      const adapter = new ClaudeAdapter({
        safeMode: o.safeMode,
        // `--safe-mode` is off here, so the user's own settings are kept out another way (see ASSUMPTIONS d3).
        extraArgs: [
          "--model",
          "haiku",
          "--no-session-persistence",
          "--max-budget-usd",
          "0.3",
          ...(o.safeMode ? [] : ["--setting-sources", "local", "--disable-slash-commands"]),
          ...(o.permissions === undefined ? ["--tools", "Write"] : []),
        ],
        taskArgs: claudeGateTaskArgs({
          configDir: join(root, "gate-config"),
          launcher: { command: process.execPath, args: [bundle] },
        }),
      });
      const events: AgentEvent[] = [];
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120_000);
      try {
        for await (const e of adapter.execute({
          id: `real-${o.name}`,
          prompt: o.prompt,
          cwd: repo,
          ...(o.permissions ? { permissions: o.permissions } : {}),
          signal: ac.signal,
        })) {
          events.push(e);
        }
      } finally {
        clearTimeout(timer);
      }
      report[o.name] = {
        events: events.map((e) => JSON.stringify(e).slice(0, 300)),
        filesInRepo: filesIn(repo),
        filesInRoot: filesIn(root),
      };
      return { events, repo, root };
    }
    const stray = (root: string) =>
      filesIn(root).filter((f) => f !== "repo" && f !== "gate-config");

    it("default adapter (--safe-mode) + gate: the gate is unusable, the write fails closed", async () => {
      const r = await runAdapter({
        name: "claude-real-gate-safe-mode",
        permissions: undefined,
        safeMode: true,
        prompt: WRITE_W,
      });
      expect(filesIn(r.repo)).not.toContain("w.txt");
    }, 180_000);

    it("--safe-mode off, workspace-write: a write inside the repo is auto-accepted by claude; one outside is decided by the gate and denied", async () => {
      const inside = await runAdapter({
        name: "claude-real-gate-inside",
        permissions: "workspace-write",
        safeMode: false,
        prompt: WRITE_W,
      });
      report["claude-real-gate-inside-wrote"] = filesIn(inside.repo);
      const outside = await runAdapter({
        name: "claude-real-gate-outside",
        permissions: "workspace-write",
        safeMode: false,
        prompt: WRITE_OUTSIDE,
      });
      expect(stray(outside.root)).toEqual([]);
    }, 300_000);

    it("--safe-mode off, no permissions flag (default mode), Write tool only: the write inside the repo reaches the gate", async () => {
      const r = await runAdapter({
        name: "claude-real-gate-default",
        permissions: undefined,
        safeMode: false,
        prompt: WRITE_W,
      });
      report["claude-real-gate-default-wrote"] = filesIn(r.repo);
      expect(stray(r.root)).toEqual([]);
    }, 180_000);
  },
);
