import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_CANDIDATES,
  capabilitiesFromHelp,
  claudeCapabilitiesFromHelp,
  codexCapabilitiesFromHelp,
  expandDir,
  scanCli,
  scanClis,
  type CliCandidate,
  type CommandResult,
  type RunFn,
} from "./index.js";

const fixture = (p: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../tests/contracts/fixtures/${p}`, import.meta.url)),
    "utf8",
  );
const candidate = (id: string) => {
  const c = CLI_CANDIDATES.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};
const ok = (stdout: string): CommandResult => ({
  outcome: "exited",
  exitCode: 0,
  stdout,
  stderr: "",
});
const scripted =
  (map: Record<string, CommandResult>): RunFn =>
  async ({ args }) =>
    map[args.join(" ")] ?? { outcome: "exited", exitCode: 2, stdout: "", stderr: "unexpected" };

// `node` is a real executable that every test machine has; `run` decides what it "prints".
const NODE_DIR = dirname(process.execPath);
const asNode = (c: CliCandidate): CliCandidate => ({ ...c, command: "node" });
const ENV_ON_PATH = { PATH: NODE_DIR, PATHEXT: ".EXE;.CMD" };

describe("candidate list is data", () => {
  it("has unique ids and commands", () => {
    const ids = CLI_CANDIDATES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(CLI_CANDIDATES.map((c) => c.command)).size).toBe(ids.length);
  });

  it("data rules give exactly what the hand-written claude/codex parsers give (real fixtures)", () => {
    const help = fixture("claude/2.1.316/help.txt");
    expect(capabilitiesFromHelp(candidate("claude").capabilities, { main: help })).toEqual(
      claudeCapabilitiesFromHelp(help),
    );
    const top = fixture("codex/0.165.0/help.txt");
    const exec = fixture("codex/0.165.0/exec-help.txt");
    expect(capabilitiesFromHelp(candidate("codex").capabilities, { main: top, exec })).toEqual(
      codexCapabilitiesFromHelp(top, exec),
    );
  });
});

describe("agy capabilities from the real --help (Antigravity 1.4.8)", () => {
  const caps = capabilitiesFromHelp(candidate("agy").capabilities, {
    main: fixture("agy/1.4.8/help.txt"),
  });
  it("sees what the help text lists", () => {
    expect(caps).toMatchObject({
      print: true,
      outputFormat: true,
      outputJson: true,
      outputStreamJson: true,
      inputStreamJson: true,
      model: true,
      mode: true,
      continue: true,
      conversation: true,
      sandbox: true,
      dangerouslySkipPermissions: true,
      addDir: true,
      jsonSchema: true,
      modelsSubcommand: true,
      mcpSubcommand: true,
      agentsSubcommand: true,
    });
  });
  it("does not invent flags that the help does not list", () => {
    const none = capabilitiesFromHelp(candidate("agy").capabilities, { main: "Usage: agy\n" });
    expect(Object.values(none).every((v) => v === false)).toBe(true);
  });
});

describe("scanCli", () => {
  it("finds a CLI on PATH, reads version and help, and marks it usable", async () => {
    const agy = asNode(candidate("agy"));
    const r = await scanCli(agy, {
      env: ENV_ON_PATH,
      run: scripted({ "--version": ok("1.4.8\n"), "--help": ok(fixture("agy/1.4.8/help.txt")) }),
    });
    expect(r).toMatchObject({ provider: "agy", status: "ok", version: "1.4.8", usable: true });
    expect(r.path?.toLowerCase()).toContain("node");
    expect(r.capabilities.outputStreamJson).toBe(true);
  });

  it("falls back to the candidate's install directory when PATH has nothing", async () => {
    const c: CliCandidate = { ...asNode(candidate("agy")), installDirs: ["%FAKE_HOME%"] };
    const r = await scanCli(c, {
      env: { PATH: "", PATHEXT: ".EXE;.CMD", FAKE_HOME: NODE_DIR },
      run: scripted({ "--version": ok("1.4.8\n"), "--help": ok(fixture("agy/1.4.8/help.txt")) }),
    });
    expect(r.usable).toBe(true);
  });

  it("reports not_installed when neither PATH nor install dirs have it", async () => {
    const r = await scanCli(candidate("agy"), { env: { PATH: "", NOPE: "x" } });
    expect(r).toMatchObject({ status: "not_installed", usable: false });
    expect(r.path).toBeUndefined();
  });

  it("does not list a vendor stub that answers --version with a message (copilot shim)", async () => {
    const r = await scanCli(asNode(candidate("copilot")), {
      env: ENV_ON_PATH,
      run: scripted({
        "--version": ok("GitHub Copilot CLI was not found. Run copilot to install.\n"),
      }),
    });
    expect(r).toMatchObject({ status: "version_unparsable", usable: false });
  });

  it("does not list a program that has a version but not the CLI's identity flags", async () => {
    const r = await scanCli(asNode(candidate("agy")), {
      env: ENV_ON_PATH,
      run: scripted({ "--version": ok("22.1.0\n"), "--help": ok("Usage: node [options]\n") }),
    });
    expect(r).toMatchObject({ status: "ok", usable: false });
  });

  it("a locate-only candidate is usable with just a version and claims no capabilities", async () => {
    const r = await scanCli(asNode(candidate("ollama")), {
      env: ENV_ON_PATH,
      run: scripted({ "--version": ok("ollama version is 0.5.1\n") }),
    });
    expect(r).toMatchObject({ status: "ok", usable: true, capabilities: {} });
  });

  it("surfaces a timeout instead of hanging the scan", async () => {
    const r = await scanCli(asNode(candidate("agy")), {
      env: ENV_ON_PATH,
      run: async () => ({ outcome: "timeout", exitCode: null, stdout: "", stderr: "" }),
    });
    expect(r).toMatchObject({ status: "timeout", usable: false });
  });

  it("new candidates need no logic change: an ad-hoc entry works", async () => {
    const extra: CliCandidate = {
      id: "demo",
      displayName: "Demo",
      command: "node",
      versionArgs: ["-v"],
      installDirs: [],
      capabilities: { fast: { flag: "--fast" } },
      identity: ["fast"],
    };
    const r = await scanClis({
      candidates: [extra],
      env: ENV_ON_PATH,
      run: scripted({ "-v": ok("3.0.0\n"), "--help": ok("  --fast  go fast\n") }),
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ provider: "demo", usable: true });
    expect(r[0]?.capabilities).toEqual({ fast: true });
  });
});

describe("expandDir", () => {
  it("expands %VAR% case-insensitively and gives up when a variable is unset", () => {
    expect(expandDir("%localappdata%\\agy\\bin", { LOCALAPPDATA: "C:\\L" })).toBe(
      "C:\\L\\agy\\bin",
    );
    expect(expandDir("%MISSING%\\x", {})).toBeUndefined();
  });
});
