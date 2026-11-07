import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { ProbeResult } from "@agent-studio/cli-probe";
import { createLogger } from "@agent-studio/shared-utils";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** The options each `CodexAppServerAdapter` was constructed with (the real class is kept; nothing is started). */
const seen = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@agent-studio/adapter-codex", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@agent-studio/adapter-codex")>();
  class Spy extends mod.CodexAppServerAdapter {
    constructor(o: ConstructorParameters<typeof mod.CodexAppServerAdapter>[0]) {
      super(o);
      seen.push(o as unknown as Record<string, unknown>);
    }
  }
  return { ...mod, CodexAppServerAdapter: Spy };
});

const { SidecarService } = await import("./sidecar.js");

/**
 * Q3 review finding: `codex-app-server` must use the same program, environment and secrets as the stored `codex`
 * settings, follow their updates, and let an explicit option override them. Fake values only.
 */
let dir: string;
let svc: InstanceType<typeof SidecarService> | undefined;
let n = 0;

const probeOk = (): ProbeResult => ({
  provider: "codex",
  status: "ok",
  path: process.execPath,
  version: "1.0.0",
  capabilities: { print: true, outputStreamJson: true, execSubcommand: true, execJson: true },
  evidence: [],
  probedAt: "2026-01-01T00:00:00.000Z",
});

function open(extra: Record<string, unknown> = {}) {
  svc = new SidecarService(
    {
      dbPath: join(dir, "data", "s.db"),
      probes: { claude: async () => probeOk(), codex: async () => probeOk() },
      ...extra,
    } as ConstructorParameters<typeof SidecarService>[0],
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
}
const call = async (method: string, params?: unknown) => {
  const { response } = await svc!.handle({ id: ++n, method, ...(params ? { params } : {}) });
  return response as { result?: Record<string, unknown>; error?: { message: string } };
};
const last = () => seen[seen.length - 1]!;
const envOf = (o: Record<string, unknown>) => o["env"] as Record<string, string>;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "as-casc-")));
  mkdirSync(join(dir, "data"));
  seen.length = 0;
});
afterEach(() => {
  svc?.close();
  svc = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("codex-app-server shares the stored codex configuration", () => {
  it("with nothing stored it keeps the defaults", () => {
    open();
    expect(last()["command"]).toBeUndefined();
    expect(last()["env"]).toBeUndefined();
  });

  it("provider secrets reach it (env and envAllow)", () => {
    open({
      secrets: { claude: {}, codex: { PROXY_TOKEN: "fake-secret-value-123" } }, // pragma: allowlist secret
    });
    expect(envOf(last())["PROXY_TOKEN"]).toBe("fake-secret-value-123");
    expect(last()["envAllow"]).toContain("PROXY_TOKEN");
  });

  it("stored command and env are used, and a later setSettings / clear updates the agent", async () => {
    open();
    const r = await call("agents.setSettings", {
      provider: "codex",
      settings: { command: process.execPath, args: ["--x"], env: { HTTPS_PROXY: "http://p" } },
    });
    expect(r.result, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(last()["command"]).toBe(process.execPath);
    expect(envOf(last())["HTTPS_PROXY"]).toBe("http://p");
    expect(last()["envAllow"]).toContain("HTTPS_PROXY");
    expect(last()["baseArgs"]).toBeUndefined(); // stored args are `codex exec` arguments: not passed

    await call("agents.setSettings", { provider: "codex", settings: null });
    expect(last()["command"]).toBeUndefined();
    const list = await call("agents.list");
    expect(
      (list.result?.["adapters"] as { id: string }[]).filter((a) => a.id === "codex-app-server"),
    ).toHaveLength(1);
  });

  it("an explicit codexAppServer option wins over the stored settings", async () => {
    open({ codexAppServer: { command: "explicit-codex" } });
    await call("agents.setSettings", {
      provider: "codex",
      settings: { command: process.execPath, args: [], env: {} },
    });
    expect(last()["command"]).toBe("explicit-codex");
  });

  it("codexAppServer:false stays off after a codex settings change", async () => {
    open({ codexAppServer: false });
    await call("agents.setSettings", {
      provider: "codex",
      settings: { command: process.execPath, args: [], env: {} },
    });
    expect(seen).toHaveLength(0);
  });
});
