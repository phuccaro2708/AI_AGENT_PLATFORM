import { describe, expect, it } from "vitest";
import { checkAgentSettings, checkArgs, checkCommand, checkEnv } from "./agent-settings.js";

describe("checkArgs", () => {
  it("accepts harmless extra arguments", () => {
    expect(checkArgs(["--model", "sonnet", "--verbose"])).toBeNull();
  });
  it.each([
    "--dangerously-skip-permissions",
    "--permission-mode",
    "--permission-mode=bypassPermissions",
    "--Tools",
    "--allowedTools",
    "-s",
    "--sandbox=danger-full-access",
    "-sread-only",
    "-cfoo=bar",
    "--full-auto",
    "--add-dir",
    "--cd",
    "-c",
    "--settings=x.json",
    "--mcp-config",
    "--resume",
  ])("refuses %s", (flag) => {
    expect(checkArgs([flag])).toMatch(/not allowed|lift/);
  });
  it("refuses a permission-lifting value even as a separate argument", () => {
    expect(checkArgs(["x", "danger-full-access"])).toMatch(/lift/);
    expect(checkArgs(["bypassPermissions"])).toMatch(/lift/);
  });
  it("limits count, length and control characters", () => {
    expect(checkArgs(Array.from({ length: 33 }, () => "a"))).toMatch(/At most/);
    expect(checkArgs(["a".repeat(513)])).toMatch(/too long/);
    expect(checkArgs(["a\nb"])).toMatch(/control/);
  });
});

describe("checkEnv", () => {
  it("accepts plain settings", () => {
    expect(
      checkEnv({ HTTPS_PROXY: "http://proxy:8080", LANG: "en_US", LC_ALL: "C", TZ: "UTC" }),
    ).toBeNull();
  });
  it("refuses names that change how programs load", () => {
    for (const n of [
      "PATH",
      "path",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "ComSpec",
      "BASH_ENV",
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_BASE_URL",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      expect(checkEnv({ [n]: "x" }), n).toMatch(/not an allowed/);
    }
  });
  it("refuses names that look like secrets", () => {
    for (const n of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN", "DB_PASSWORD"]) {
      expect(checkEnv({ [n]: "x" }), n).toMatch(/credential store/);
    }
  });
  it("refuses bad names and values", () => {
    expect(checkEnv({ "A B": "x" })).toMatch(/valid/);
    expect(checkEnv({ "1A": "x" })).toMatch(/valid/);
    expect(checkEnv({ TZ: "x\u0000y" })).toMatch(/control/);
    expect(checkEnv({ TZ: "x".repeat(1025) })).toMatch(/too long/);
  });
});

describe("checkCommand", () => {
  it("resolves the running node as a real executable", () => {
    const r = checkCommand(process.execPath);
    expect(r).toMatchObject({ ok: true });
  });
  it("refuses empty, missing and relative-with-directory commands", () => {
    expect(checkCommand("  ")).toMatchObject({ ok: false });
    expect(checkCommand("no-such-program-agent-studio")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/No executable/),
    });
    expect(checkCommand("./tools/claude")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/absolute/),
    });
  });
});

describe("checkAgentSettings", () => {
  it("returns the trimmed command and the resolved path", () => {
    const r = checkAgentSettings({ command: ` ${process.execPath} `, args: ["--x"], env: {} });
    expect(r).toMatchObject({ ok: true, settings: { command: process.execPath, args: ["--x"] } });
  });
  it("reports the first problem", () => {
    expect(checkAgentSettings({ command: process.execPath, args: ["-s"], env: {} })).toMatchObject({
      ok: false,
    });
  });
});
