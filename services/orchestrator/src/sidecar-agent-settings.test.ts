import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { ProbeResult } from "@agent-studio/cli-probe";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

let dir: string;
let svc: SidecarService;
const sink = new Writable({ write: (_c, _e, cb) => cb() });
const log = () => createLogger({ name: "t", destination: sink });

const probeOk = (provider: "claude" | "codex"): ProbeResult => ({
  provider,
  status: "ok",
  path: process.execPath,
  version: "1.0.0",
  capabilities: { print: true },
  evidence: [],
  probedAt: "2026-01-01T00:00:00.000Z",
});
const probeBad = (provider: "claude" | "codex"): ProbeResult => ({
  provider,
  status: "exit_nonzero",
  capabilities: {},
  evidence: [],
  error: { status: "exit_nonzero", message: "it did not start" },
  probedAt: "2026-01-01T00:00:00.000Z",
});

/** Probes are replaced by `fake`; the settings flow itself is what is under test. */
const open = (fake: (provider: "claude" | "codex") => ProbeResult) =>
  new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      probes: {
        claude: async () => fake("claude"),
        codex: async () => fake("codex"),
      },
    },
    log(),
  );

const call = async (s: SidecarService, method: string, params?: unknown) => {
  const { response } = await s.handle({ id: 1, method, ...(params ? { params } : {}) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return response as { result?: Record<string, any>; error?: { message: string } };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-settings-"));
});
afterEach(() => {
  svc?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("agent launch settings (7B)", () => {
  it("probe checks the settings but stores nothing", async () => {
    svc = open(probeOk);
    const r = await call(svc, "agents.probe", {
      provider: "claude",
      settings: { command: process.execPath, args: [], env: {} },
    });
    expect(r.result).toMatchObject({ ok: true, resolvedPath: process.execPath });
    expect((await call(svc, "agents.getSettings", { provider: "claude" })).result?.settings).toBe(
      null,
    );
  });

  it("passes the settings' executable and environment to the probe", async () => {
    const seen: { executable?: string; env?: Record<string, string | undefined> }[] = [];
    svc = new SidecarService(
      {
        dbPath: join(dir, "s.db"),
        probes: {
          claude: async (o) => {
            seen.push(o ?? {});
            return probeOk("claude");
          },
        },
      },
      log(),
    );
    await call(svc, "agents.probe", {
      provider: "claude",
      settings: { command: process.execPath, args: [], env: { HTTPS_PROXY: "http://p:1" } },
    });
    expect(seen[0]?.executable).toBe(process.execPath);
    expect(seen[0]?.env?.["HTTPS_PROXY"]).toBe("http://p:1");
  });

  it("does not accept a program that is not the CLI (version prints, no known options)", async () => {
    svc = open((p) => ({ ...probeOk(p), capabilities: { print: false } }));
    const r = await call(svc, "agents.setSettings", {
      provider: "claude",
      settings: { command: process.execPath, args: [], env: {} },
    });
    expect(r.result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/does not look like/),
    });
    expect((await call(svc, "agents.getSettings", { provider: "claude" })).result?.settings).toBe(
      null,
    );
  });

  it("saves verified settings, keeps them across a restart, and records the probe", async () => {
    svc = open(probeOk);
    const r = await call(svc, "agents.setSettings", {
      provider: "claude",
      settings: { command: process.execPath, args: ["--model", "x"], env: { LANG: "C" } },
    });
    expect(r.result).toMatchObject({ ok: true, resolvedPath: process.execPath });
    svc.close();
    svc = open(probeOk);
    const got = await call(svc, "agents.getSettings", { provider: "claude" });
    expect(got.result?.settings).toMatchObject({
      command: process.execPath,
      args: ["--model", "x"],
      env: { LANG: "C" },
    });
    expect(
      (await call(svc, "agents.capabilities", { provider: "claude" })).result?.probe,
    ).toMatchObject({ status: "ok" });
  });

  it("refuses unsafe settings before any probe runs", async () => {
    svc = open(probeOk);
    const bad = [
      { command: process.execPath, args: ["--dangerously-skip-permissions"], env: {} },
      { command: process.execPath, args: [], env: { ANTHROPIC_API_KEY: "sk-test" } }, // pragma: allowlist secret
      { command: "no-such-program-agent-studio", args: [], env: {} },
    ];
    for (const settings of bad) {
      const r = await call(svc, "agents.setSettings", { provider: "claude", settings });
      expect(r.result?.ok).toBe(false);
      expect(typeof r.result?.reason).toBe("string");
    }
    expect((await call(svc, "agents.getSettings", { provider: "claude" })).result?.settings).toBe(
      null,
    );
  });

  it("does not save settings whose probe fails, and keeps the ones that work", async () => {
    svc = open(probeBad);
    const r = await call(svc, "agents.setSettings", {
      provider: "codex",
      settings: { command: process.execPath, args: [], env: {} },
    });
    expect(r.result).toMatchObject({ ok: false });
    expect((await call(svc, "agents.getSettings", { provider: "codex" })).result?.settings).toBe(
      null,
    );
  });

  it("settings: null goes back to defaults", async () => {
    svc = open(probeOk);
    const repo = (svc as unknown as { repo: import("@agent-studio/storage").Repo }).repo;
    repo.saveAgentSettings({
      provider: "codex",
      command: process.execPath,
      args: [],
      env: {},
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const r = await call(svc, "agents.setSettings", { provider: "codex", settings: null });
    expect(r.result).toMatchObject({ ok: true, settings: null });
    expect((await call(svc, "agents.getSettings", { provider: "codex" })).result?.settings).toBe(
      null,
    );
  });

  it("rejects an unknown provider", async () => {
    svc = open(probeOk);
    expect((await call(svc, "agents.getSettings", { provider: "gemini" })).error?.message).toBe(
      "invalid request",
    );
  });
});
