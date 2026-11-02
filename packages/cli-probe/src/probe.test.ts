import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  claudeCapabilitiesFromHelp,
  hasFlag,
  hasSubcommand,
  parseVersion,
  probeClaude,
  probeCodex,
} from "./index.js";
import type { CommandResult, RunFn } from "./index.js";

const fixture = (p: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../tests/contracts/fixtures/${p}`, import.meta.url)),
    "utf8",
  );

// Any real executable works as the "CLI"; the injected `run` decides what it "prints".
const EXE = process.execPath;
const ok = (stdout: string): CommandResult => ({
  outcome: "exited",
  exitCode: 0,
  stdout,
  stderr: "",
});
const scripted =
  (map: Record<string, CommandResult>): RunFn =>
  async ({ args }) =>
    map[args.join(" ")] ?? {
      outcome: "exited",
      exitCode: 2,
      stdout: "",
      stderr: "unexpected args",
    };

describe("helpers", () => {
  it("hasFlag matches whole flags only", () => {
    expect(hasFlag("  --resume [value]  Resume", "--resume")).toBe(true);
    expect(hasFlag("  -r, --resume [value]", "--resume")).toBe(true);
    expect(hasFlag("  --resume-session-at <id>", "--resume")).toBe(false);
    expect(hasFlag("  --no-session-persistence", "--session-persistence")).toBe(false);
  });
  it("hasSubcommand needs an indented command line", () => {
    expect(hasSubcommand("Commands:\n  exec        Run non-interactively\n", "exec")).toBe(true);
    expect(hasSubcommand("run codex exec to start\n", "exec")).toBe(false);
  });
  it("parseVersion", () => {
    expect(parseVersion("2.1.316 (Claude Code)\n")).toBe("2.1.316 (Claude Code)");
    expect(parseVersion("codex-cli 0.5.1\n")).toBe("codex-cli 0.5.1");
    expect(parseVersion("hello world")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });
});

describe("Claude help fixture (REAL output captured from claude 2.1.316)", () => {
  const help = fixture("claude/2.1.316/help.txt");
  const caps = claudeCapabilitiesFromHelp(help);
  it("reports the flags that appear in the real help", () => {
    for (const k of [
      "print",
      "outputFormat",
      "outputStreamJson",
      "inputStreamJson",
      "includePartialMessages",
      "verbose",
      "resume",
      "sessionId",
      "forkSession",
      "noSessionPersistence",
      "permissionMode",
      "allowedTools",
      "disallowedTools",
      "model",
      "mcpConfig",
      "jsonSchema",
      "maxBudgetUsd",
      "addDir",
    ]) {
      expect(caps[k], k).toBe(true);
    }
  });
  it("a help text with nothing useful reports everything false", () => {
    expect(Object.values(claudeCapabilitiesFromHelp("Usage: claude\n")).some(Boolean)).toBe(false);
  });
  it("probeClaude over the real fixture yields ok with the fixture version", async () => {
    const r = await probeClaude({
      executable: EXE,
      run: scripted({
        "--version": ok(fixture("claude/2.1.316/version.txt")),
        "--help": ok(help),
      }),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(r).toMatchObject({
      provider: "claude",
      status: "ok",
      kind: "exe",
      version: "2.1.316 (Claude Code)",
    });
    expect(r.capabilities.outputStreamJson).toBe(true);
    expect(r.probedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("REAL fixtures captured on the Legion (2026-11-01)", () => {
  it("claude 2.1.314: same capabilities as 2.1.316", async () => {
    const r = await probeClaude({
      executable: EXE,
      run: scripted({
        "--version": ok(fixture("claude/2.1.314/version.txt")),
        "--help": ok(fixture("claude/2.1.314/help.txt")),
      }),
    });
    expect(r).toMatchObject({ status: "ok", version: "2.1.314 (Claude Code)" });
    expect(r.capabilities).toEqual(claudeCapabilitiesFromHelp(fixture("claude/2.1.316/help.txt")));
  });
  it("codex-cli 0.165.0: app-server, exec --json, resume are reported", async () => {
    const r = await probeCodex({
      executable: EXE,
      run: scripted({
        "--version": ok(fixture("codex/0.165.0/version.txt")),
        "--help": ok(fixture("codex/0.165.0/help.txt")),
        "exec --help": ok(fixture("codex/0.165.0/exec-help.txt")),
      }),
    });
    expect(r).toMatchObject({ provider: "codex", status: "ok", version: "codex-cli 0.165.0" });
    expect(r.capabilities).toMatchObject({
      execSubcommand: true,
      appServerSubcommand: true,
      resumeSubcommand: true,
      execJson: true,
      execSandbox: true,
    });
  });
});

describe("error reporting (B4): never throws, always explains", () => {
  it("not installed", async () => {
    const r = await probeClaude({ env: { PATH: "" } });
    expect(r.status).toBe("not_installed");
    expect(r.error?.message).toMatch(/not found/i);
  });
  it("non-zero exit on --version keeps stderr tail", async () => {
    const r = await probeClaude({
      executable: EXE,
      run: scripted({
        "--version": { outcome: "exited", exitCode: 3, stdout: "", stderr: "boom: bad config" },
      }),
    });
    expect(r.status).toBe("exit_nonzero");
    expect(r.error).toMatchObject({
      step: "--version",
      exitCode: 3,
      stderrTail: "boom: bad config",
    });
  });
  it("timeout", async () => {
    const r = await probeClaude({
      executable: EXE,
      run: scripted({
        "--version": { outcome: "timeout", exitCode: null, stdout: "", stderr: "" },
      }),
    });
    expect(r.status).toBe("timeout");
  });
  it("spawn error", async () => {
    const r = await probeClaude({
      executable: EXE,
      run: scripted({
        "--version": {
          outcome: "spawn_error",
          exitCode: null,
          stdout: "",
          stderr: "",
          error: "EACCES",
        },
      }),
    });
    expect(r.status).toBe("spawn_error");
    expect(r.error?.message).toMatch(/EACCES/);
  });
  it("garbage version output", async () => {
    const r = await probeClaude({
      executable: EXE,
      run: scripted({ "--version": ok("<html>captive portal</html>") }),
    });
    expect(r.status).toBe("version_unparsable");
  });
  it("--help failing after a good --version is reported with the version kept", async () => {
    const r = await probeClaude({
      executable: EXE,
      run: scripted({
        "--version": ok("2.1.316 (Claude Code)\n"),
        "--help": { outcome: "exited", exitCode: 1, stdout: "", stderr: "nope" },
      }),
    });
    expect(r).toMatchObject({ status: "exit_nonzero", version: "2.1.316 (Claude Code)" });
    expect(r.error?.step).toBe("--help");
  });
});

describe("Codex probe (SYNTHETIC help text: no real codex output has been captured yet)", () => {
  const top =
    "Usage: codex [OPTIONS] [COMMAND]\n\nCommands:\n  exec        Run non-interactively\n  app-server  Run the app server\n";
  const exec = "Usage: codex exec [OPTIONS]\n\nOptions:\n      --json   Print events as JSONL\n";
  it("detects subcommands and flags from help text only", async () => {
    const r = await probeCodex({
      executable: EXE,
      run: scripted({
        "--version": ok("codex-cli 9.9.9\n"),
        "--help": ok(top),
        "exec --help": ok(exec),
      }),
    });
    expect(r.status).toBe("ok");
    expect(r.capabilities).toMatchObject({
      execSubcommand: true,
      appServerSubcommand: true,
      execJson: true,
    });
    expect(r.capabilities.execSandbox).toBe(false);
  });
  it("without an exec subcommand, exec help is not requested", async () => {
    const r = await probeCodex({
      executable: EXE,
      run: scripted({
        "--version": ok("codex-cli 9.9.9\n"),
        "--help": ok("Commands:\n  login  Log in\n"),
      }),
    });
    expect(r.status).toBe("ok");
    expect(r.capabilities.execSubcommand).toBe(false);
    expect(r.capabilities.execJson).toBe(false);
  });
  it("not installed", async () => {
    expect((await probeCodex({ env: { PATH: "" } })).status).toBe("not_installed");
  });
});
