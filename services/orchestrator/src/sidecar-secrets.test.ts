import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { ProbeOptions, ProbeResult } from "@agent-studio/cli-probe";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

const CLAUDE_SECRET = "sk-ant-test-0123456789-claude"; // pragma: allowlist secret
const CODEX_SECRET = "sk-oai-test-9876543210-codex"; // pragma: allowlist secret

let dir: string;
let svc: SidecarService;
let logged = "";
const sink = new Writable({
  write: (c, _e, cb) => {
    logged += String(c);
    cb();
  },
});

const ok = (provider: "claude" | "codex"): ProbeResult => ({
  provider,
  status: "ok",
  path: process.execPath,
  version: "1.0.0",
  capabilities: { print: true },
  evidence: [],
  probedAt: "2026-01-01T00:00:00.000Z",
});

const call = async (s: SidecarService, method: string, params?: unknown) => {
  const { response } = await s.handle({ id: 1, method, ...(params ? { params } : {}) });
  return response as { result?: Record<string, unknown>; error?: { message: string } };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-secrets-"));
  logged = "";
});
afterEach(() => {
  svc?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("secrets in the sidecar (7B)", () => {
  it("gives each provider only its own secrets, to its probe and nowhere else", async () => {
    const seen: Record<string, ProbeOptions | undefined> = {};
    svc = new SidecarService(
      {
        dbPath: join(dir, "s.db"),
        secrets: {
          claude: { ANTHROPIC_API_KEY: CLAUDE_SECRET },
          codex: { OPENAI_API_KEY: CODEX_SECRET },
        },
        probes: {
          claude: async (o) => ((seen["claude"] = o), ok("claude")),
          codex: async (o) => ((seen["codex"] = o), ok("codex")),
        },
      },
      createLogger({ name: "t", destination: sink }),
    );
    for (const provider of ["claude", "codex"] as const) {
      await call(svc, "agents.probe", {
        provider,
        settings: { command: process.execPath, args: [], env: {} },
      });
    }
    expect(seen["claude"]?.env?.["ANTHROPIC_API_KEY"]).toBe(CLAUDE_SECRET);
    expect(seen["claude"]?.env?.["OPENAI_API_KEY"]).toBeUndefined();
    expect(seen["codex"]?.env?.["OPENAI_API_KEY"]).toBe(CODEX_SECRET);
    expect(seen["codex"]?.env?.["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("never lets a secret reach the database, the logs or any response", async () => {
    const responses: string[] = [];
    svc = new SidecarService(
      {
        dbPath: join(dir, "s.db"),
        secrets: {
          claude: { ANTHROPIC_API_KEY: CLAUDE_SECRET },
          codex: { OPENAI_API_KEY: CODEX_SECRET },
        },
        probes: { claude: async () => ok("claude"), codex: async () => ok("codex") },
      },
      createLogger({ name: "t", destination: sink }),
    );
    const run = async (method: string, params?: unknown) => {
      const r = await call(svc, method, params);
      responses.push(JSON.stringify(r));
      return r;
    };
    const root = join(dir, "projects", "p");
    mkdirSync(root, { recursive: true });
    const project = await run("projects.create", {
      name: "p",
      rootPath: realpathSync.native(root),
    });
    const wf = await run("workflows.create", { projectId: project.result?.["projectId"] });
    await run("workflows.start", {
      workflowId: wf.result?.["workflowId"],
      agentId: "stub",
      prompt: "hello",
    });
    await svc.idle();
    await run("agents.list");
    await run("agents.detect");
    await run("agents.getSettings", { provider: "claude" });
    await run("agents.setSettings", {
      provider: "claude",
      settings: { command: process.execPath, args: ["--model", "x"], env: { LANG: "C" } },
    });
    await run("health");
    svc.close();

    const files = readdirSync(dir).filter((f) => f.startsWith("s.db"));
    expect(files.length).toBeGreaterThan(0);
    const haystack = [
      logged,
      ...responses,
      ...files.map((f) => readFileSync(join(dir, f)).toString("latin1")),
    ].join("\n");
    for (const secret of [CLAUDE_SECRET, CODEX_SECRET]) {
      expect(haystack).not.toContain(secret);
    }
  });

  it("reports whether work is in flight, for the native restart check", async () => {
    svc = new SidecarService(
      { dbPath: join(dir, "s.db") },
      createLogger({ name: "t", destination: sink }),
    );
    expect((await call(svc, "system.activeTasks")).result).toEqual({ count: 0 });
  });
});
