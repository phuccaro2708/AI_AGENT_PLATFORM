import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AdapterRegistry, AgentTask } from "@agent-studio/agent-core";
import type { ProbeResult } from "@agent-studio/cli-probe";
import { createLogger } from "@agent-studio/shared-utils";
import { assertSafeLocalSettings, claudeGateTaskArgs } from "./claude-permission-gate.js";
import { SidecarService } from "./sidecar.js";

/**
 * Q3 (2026-11-07): the Claude permission gate and the `codex-app-server` agent are ON by default. Nothing here starts
 * a CLI: the launch is read with `describeLaunch`, and the refusal cases stop before any program is started.
 */
let dir: string;
let svc: SidecarService | undefined;
let n = 0;

const probeOk = (provider: "claude" | "codex"): ProbeResult => ({
  provider,
  status: "ok",
  path: process.execPath,
  version: "1.0.0",
  capabilities: { print: true, outputStreamJson: true, execSubcommand: true, execJson: true },
  evidence: [],
  probedAt: "2026-01-01T00:00:00.000Z",
});

type Rpc = { result?: Record<string, unknown>; error?: { message: string } };
const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc!.handle({ id: ++n, method, ...(params ? { params } : {}) });
  const r = response as Rpc;
  if (r.error) throw new Error(r.error.message);
  return r.result as T;
};

function open(extra: Partial<ConstructorParameters<typeof SidecarService>[0]> = {}) {
  svc = new SidecarService(
    {
      dbPath: join(dir, "data", "s.db"),
      worktreesDir: join(dir, "wt"),
      schedulerIntervalMs: 20,
      probes: { claude: async () => probeOk("claude"), codex: async () => probeOk("codex") },
      ...extra,
    },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
}

const taskOf = (permissions?: AgentTask["permissions"]): AgentTask =>
  ({
    id: "task_x",
    cwd: dir,
    prompt: "p",
    permissions,
    signal: new AbortController().signal,
  }) as unknown as AgentTask;

/** The launch the registered `claude` adapter would perform (nothing is started). */
const claudeLaunch = (permissions?: AgentTask["permissions"]) => {
  const registry = (svc as unknown as { registry: AdapterRegistry }).registry;
  return registry.get("claude")!.describeLaunch!(taskOf(permissions));
};
const valueOf = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1];

/** Starts a task on the default `claude` agent and returns the task's log text (used for refusals only). */
async function runClaudeTask(): Promise<string> {
  const root = join(dir, "proj");
  mkdirSync(root, { recursive: true });
  const { projectId } = await call<{ projectId: string }>("projects.create", {
    name: "p",
    rootPath: root,
  });
  const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
  await call("workflows.start", { workflowId, agentId: "claude", prompt: "go" });
  await svc!.idle();
  const { tasks } = await call<{ tasks: { id: string; state: string }[] }>("tasks.list", {
    workflowId,
  });
  expect(tasks.map((t) => t.state)).toEqual(["failed"]);
  return JSON.stringify(
    await call("logs.query", { taskId: tasks[0]!.id, afterSequence: 0, limit: 100 }),
  );
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "as-gates-")));
  mkdirSync(join(dir, "data"));
});
afterEach(() => {
  svc?.close();
  svc = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Claude permission gate, default ON (Q3)", () => {
  it("is ON by default: gate flags, askEveryTool and settings isolation, and no --safe-mode", () => {
    open();
    const { args } = claudeLaunch();
    expect(valueOf(args, "--permission-prompt-tool")).toBe("mcp__gate__approve");
    expect(args).toContain("--strict-mcp-config");
    expect(existsSync(valueOf(args, "--mcp-config")!)).toBe(true);
    expect(valueOf(args, "--setting-sources")).toBe("local");
    expect(JSON.parse(valueOf(args, "--settings")!)).toEqual({
      permissions: { ask: ["Write", "Edit", "Read", "Glob", "Grep", "Bash"] },
      disableAllHooks: true,
    });
    expect(valueOf(args, "--tools")).toBe("Write,Edit,Read,Glob,Grep,Bash");
    expect(args).not.toContain("--safe-mode");
  });

  it("with task permissions the adapter's own --tools is kept and no second --tools is added", () => {
    open();
    const { args } = claudeLaunch("read-only");
    expect(args.filter((a) => a === "--tools")).toEqual(["--tools"]);
    expect(valueOf(args, "--tools")).toBe("Read,Grep,Glob");
    expect(valueOf(args, "--permission-prompt-tool")).toBe("mcp__gate__approve");
  });

  it("the off switch (claudePermissionGate:false) restores the old launch: --safe-mode, no gate flags", () => {
    open({ claudePermissionGate: false });
    const { args } = claudeLaunch();
    expect(args).toContain("--safe-mode");
    for (const flag of ["--permission-prompt-tool", "--mcp-config", "--settings", "--tools"]) {
      expect(args).not.toContain(flag);
    }
  });

  it("missing launcher: the launch cannot be described and a started task is refused (fail closed)", async () => {
    open({
      claudePermissionGate: {
        launcher: { command: process.execPath, args: [join(dir, "no-such-sidecar.js")] },
      },
    });
    expect(() => claudeLaunch()).toThrow(/launcher not found/);
    expect(await runClaudeTask()).toContain("policy gate failed");
  });

  it("--safe-mode path: stored arguments that bring --safe-mode back are refused, not run without the gate", async () => {
    open();
    const set = await call<{ ok: boolean }>("agents.setSettings", {
      provider: "claude",
      settings: { command: process.execPath, args: ["--safe-mode"], env: {} },
    });
    expect(set.ok).toBe(true);
    expect(() => claudeLaunch()).toThrow(/--safe-mode/);
    expect(await runClaudeTask()).toContain("policy gate failed");
  });
});

describe("settings.local.json that can run code outside the gate is refused (review 2026-11-07)", () => {
  const put = (text: string) => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), text);
  };

  it("no file, or only permissions/model/$schema: accepted", () => {
    expect(() => assertSafeLocalSettings(dir)).not.toThrow();
    put(JSON.stringify({ $schema: "x", model: "haiku", permissions: { defaultMode: "plan" } }));
    expect(() => assertSafeLocalSettings(dir)).not.toThrow();
  });

  it("env (NODE_OPTIONS), apiKeyHelper, statusLine, hooks and unknown keys: refused, naming keys but not values", () => {
    put(
      JSON.stringify({
        env: { NODE_OPTIONS: "--require SECRET-PRELOAD" },
        apiKeyHelper: "SECRET-HELPER",
        statusLine: {},
        hooks: {},
        whatever: 1,
      }),
    );
    try {
      assertSafeLocalSettings(dir);
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      for (const k of ["env", "apiKeyHelper", "statusLine", "hooks", "whatever"]) {
        expect(m).toContain(k);
      }
      expect(m).not.toContain("SECRET");
    }
  });

  it("unparseable or non-object file: refused (fail closed)", () => {
    for (const text of ["{nope", "[]", "null", "7"]) {
      put(text);
      expect(() => assertSafeLocalSettings(dir)).toThrow(/settings\.local\.json/);
    }
  });

  it("through the default claude adapter: describeLaunch throws and a started task is refused before claude runs", async () => {
    open();
    put(JSON.stringify({ apiKeyHelper: "x" }));
    // the project root for the task is `dir/proj`; place the file there for the refusal run
    mkdirSync(join(dir, "proj", ".claude"), { recursive: true });
    writeFileSync(
      join(dir, "proj", ".claude", "settings.local.json"),
      JSON.stringify({ env: { NODE_OPTIONS: "x" } }),
    );
    expect(() => claudeLaunch()).toThrow(/apiKeyHelper/);
    expect(await runClaudeTask()).toContain("policy gate failed");
  });

  it("with the gate off nothing is checked", () => {
    open({ claudePermissionGate: false });
    put(JSON.stringify({ apiKeyHelper: "x" }));
    expect(() => claudeLaunch()).not.toThrow();
  });
});

describe("claudeGateTaskArgs options added for the default (Q3)", () => {
  const base = { configDir: "", launcher: { command: process.execPath, args: [__filename] } };
  const withDir = () => ({ ...base, configDir: join(dir, "gate") });

  it("askEveryTool without task permissions adds exactly one --tools with the six tools", () => {
    const args = claudeGateTaskArgs({ ...withDir(), askEveryTool: true })(taskOf());
    expect(args.filter((a) => a === "--tools")).toHaveLength(1);
    expect(valueOf(args, "--tools")).toBe("Write,Edit,Read,Glob,Grep,Bash");
  });

  it("askEveryTool with task permissions adds no --tools (the adapter already has its own)", () => {
    const args = claudeGateTaskArgs({ ...withDir(), askEveryTool: true })(
      taskOf("workspace-write"),
    );
    expect(args).not.toContain("--tools");
  });

  it("isolateSettings adds --setting-sources local; without it nothing is added", () => {
    expect(
      valueOf(
        claudeGateTaskArgs({ ...withDir(), isolateSettings: true })(taskOf()),
        "--setting-sources",
      ),
    ).toBe("local");
    expect(claudeGateTaskArgs(withDir())(taskOf())).not.toContain("--setting-sources");
  });

  it("isolateSettings alone sends ONE --settings with disableAllHooks and no permissions; hooks stay enabled without it", () => {
    const only = claudeGateTaskArgs({ ...withDir(), isolateSettings: true })(taskOf());
    expect(only.filter((a) => a === "--settings")).toHaveLength(1);
    expect(JSON.parse(valueOf(only, "--settings")!)).toEqual({ disableAllHooks: true });
    expect(claudeGateTaskArgs(withDir())(taskOf())).not.toContain("--settings");
    const ask = claudeGateTaskArgs({ ...withDir(), askEveryTool: true })(taskOf());
    expect(JSON.parse(valueOf(ask, "--settings")!)).not.toHaveProperty("disableAllHooks");
  });

  it("requireLauncher throws for an empty, relative or missing launcher script", () => {
    for (const script of ["", "relative/sidecar.js", join(dir, "nope.js")]) {
      const build = claudeGateTaskArgs({
        ...withDir(),
        launcher: { command: process.execPath, args: [script] },
        requireLauncher: true,
      });
      expect(() => build(taskOf())).toThrow(/launcher/);
    }
  });
});

describe("codex-app-server agent, default ON (Q3)", () => {
  it("is registered by default (and `codex` itself is the gated app-server adapter, see below)", async () => {
    open();
    const { adapters } = await call<{ adapters: { id: string }[] }>("agents.list");
    expect(adapters.map((a) => a.id)).toEqual(["claude", "codex", "agy", "codex-app-server"]);
  });

  it("the `codex` agent is the gated app-server adapter by default (declares approval) and codex exec when the gate is off", async () => {
    const caps = async () => {
      const registry = (svc as unknown as { registry: AdapterRegistry }).registry;
      return registry.get("codex")!.capabilities();
    };
    open();
    expect(await caps()).toContain("approval");
    svc?.close();
    open({ codexAppServer: false });
    expect(await caps()).not.toContain("approval");
  });

  it("codexAppServer:false switches it off", async () => {
    open({ codexAppServer: false });
    const { adapters } = await call<{ adapters: { id: string }[] }>("agents.list");
    expect(adapters.map((a) => a.id)).not.toContain("codex-app-server");
  });
});
