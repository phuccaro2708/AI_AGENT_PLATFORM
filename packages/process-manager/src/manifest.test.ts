import { describe, expect, it } from "vitest";
import {
  BASE_ENV_ALLOWLIST,
  assertExecutableAllowed,
  executableName,
  extendManifest,
  filterEnv,
  runProcess,
  SpawnDeniedError,
  type SpawnManifest,
} from "./index.js";

const printEnv = ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"];

describe("filterEnv", () => {
  const manifest: SpawnManifest = {
    executables: ["tool"],
    env: ["PATH", "KEEP_ME"],
    envPrefixes: ["TOOL_"],
  };

  it("drops every variable the manifest does not declare", () => {
    const out = filterEnv(
      manifest,
      { PATH: "/bin", KEEP_ME: "1", TOOL_KEY: "k", NODE_OPTIONS: "--require x", SECRET: "s" },
      "linux",
    );
    expect(out).toEqual({ PATH: "/bin", KEEP_ME: "1", TOOL_KEY: "k" });
  });

  it("never passes undefined values", () => {
    expect(filterEnv(manifest, { PATH: undefined, KEEP_ME: "1" }, "linux")).toEqual({
      KEEP_ME: "1",
    });
  });

  it("compares names case-insensitively on Windows only, keeping the original spelling", () => {
    const env = { Path: "C:\\bin", keep_me: "1", tool_x: "2" };
    expect(filterEnv(manifest, env, "win32")).toEqual(env);
    expect(filterEnv(manifest, env, "linux")).toEqual({});
  });

  it("the base list carries no code-loading or credential variables", () => {
    for (const bad of ["NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH", "AWS_SECRET_ACCESS_KEY"]) {
      expect(BASE_ENV_ALLOWLIST).not.toContain(bad);
    }
  });
});

describe("assertExecutableAllowed", () => {
  const manifest: SpawnManifest = { executables: ["claude"], env: [] };

  it("accepts the declared name, with a path or a Windows extension", () => {
    expect(() => assertExecutableAllowed(manifest, "claude")).not.toThrow();
    expect(() => assertExecutableAllowed(manifest, "C:\\bin\\Claude.EXE")).not.toThrow();
    expect(() => assertExecutableAllowed(manifest, "/usr/bin/claude")).not.toThrow();
  });

  it("rejects anything else, including a shell and an empty command", () => {
    for (const cmd of ["cmd", "powershell.exe", "claude-evil", "", "/bin/sh"]) {
      expect(() => assertExecutableAllowed(manifest, cmd)).toThrow(SpawnDeniedError);
    }
  });

  it("extendManifest declares extra names without touching the original", () => {
    const wider = extendManifest(manifest, { executables: ["C:\\x\\mine.exe"], env: ["A"] });
    expect(() => assertExecutableAllowed(wider, "mine")).not.toThrow();
    expect(() => assertExecutableAllowed(manifest, "mine")).toThrow(SpawnDeniedError);
    expect(manifest.env).toEqual([]);
    expect(executableName("C:\\x\\Mine.CMD")).toBe("mine");
  });
});

describe("startProcess with a manifest", () => {
  const node = process.execPath;

  it("refuses an executable outside the list and starts nothing", async () => {
    const r = await runProcess({
      command: node,
      args: printEnv,
      manifest: { executables: ["claude"], env: BASE_ENV_ALLOWLIST },
    });
    expect(r.outcome).toBe("spawn_error");
    expect(r.error).toMatch(/not allowed by the adapter manifest/);
    expect(r.pid).toBeUndefined();
    expect(r.stdout).toBe("");
  });

  it("starts a declared executable and hands it only the declared variables", async () => {
    const r = await runProcess({
      command: node,
      args: printEnv,
      env: {
        ...process.env,
        UNDECLARED_SECRET: "leak",
        NODE_OPTIONS: "--no-warnings",
        DECLARED_ONE: "ok",
      },
      manifest: { executables: [node], env: [...BASE_ENV_ALLOWLIST, "DECLARED_ONE"] },
    });
    expect(r.outcome).toBe("exited");
    expect(r.exitCode).toBe(0);
    const keys = JSON.parse(r.stdout) as string[];
    expect(keys).toContain("DECLARED_ONE");
    expect(keys).not.toContain("UNDECLARED_SECRET");
    expect(keys).not.toContain("NODE_OPTIONS");
  });

  it("without a manifest nothing is filtered (cli-probe and git-worktrees keep their behaviour)", async () => {
    const r = await runProcess({
      command: node,
      args: printEnv,
      env: { ...process.env, UNDECLARED_SECRET: "x" },
    });
    expect(JSON.parse(r.stdout) as string[]).toContain("UNDECLARED_SECRET");
  });
});
