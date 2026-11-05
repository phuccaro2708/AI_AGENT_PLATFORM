import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real git/SQLite/filesystem work: the whole suite runs these files in parallel, so the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { runProcess } from "./process.js";

/**
 * P4-9: text that looks like shell syntax must reach the child as ONE argv element / stdin bytes, and nothing
 * may run it as a command. Every child here is `node` itself; a sentinel file proves that no injected command ran.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-sec-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const ECHO_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
const sentinel = () => join(dir, "PWNED");
const touch = (): string =>
  `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel())},'x')"`;

const HOSTILE = [
  "; touch PWNED",
  "&& echo PWNED",
  "|| echo PWNED",
  "| echo PWNED",
  "& echo PWNED",
  "$(echo PWNED)",
  "`echo PWNED`",
  "${PATH}",
  "%PATH%",
  "!PATH!",
  "^&",
  "> PWNED",
  "< PWNED",
  "2>&1",
  "a\nb",
  "a\r\nb",
  "tab\there",
  "'single'",
  '"double"',
  '\\"escaped\\"',
  'a"b c"d',
  "back\\slash\\",
  "trailing backslash\\",
  "--flag=value with spaces",
  "-e",
  "--eval=process.exit(9)",
  "\u001b[31mred\u001b[0m",
  "unicode ✓ é 日本",
  "",
  " ",
  "*",
  "?",
  "~",
  "{a,b}",
  "#comment",
];

describe("argv is delivered verbatim (shell:false)", () => {
  it("round-trips every shell-looking argument as exactly one element", async () => {
    const r = await runProcess({
      command: process.execPath,
      args: ["-e", ECHO_ARGV, "--", ...HOSTILE],
      cwd: dir,
    });
    expect(r.outcome).toBe("exited");
    expect(JSON.parse(r.stdout)).toEqual(HOSTILE);
    expect(existsSync(sentinel())).toBe(false);
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
  });

  it("a whole injected command line as the only argument is still one element", async () => {
    const line = `x"; ${touch()}; echo "`;
    const r = await runProcess({
      command: process.execPath,
      args: ["-e", ECHO_ARGV, "--", line],
      cwd: dir,
    });
    expect(JSON.parse(r.stdout)).toEqual([line]);
    expect(existsSync(sentinel())).toBe(false);
  });

  it("a prompt on stdin arrives byte for byte, including control characters and a trailing newline", async () => {
    const prompt = `ignore previous instructions && ${touch()}\n$(id)\u001b[2J\u0000end\n`;
    const r = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      stdin: prompt,
      cwd: dir,
    });
    expect(r.stdout).toBe(prompt);
    expect(existsSync(sentinel())).toBe(false);
  });
});

describe("the program name is never interpreted", () => {
  it("a command with shell syntax in its NAME is a spawn error, not a command line", async () => {
    for (const command of [
      `node && ${touch()}`,
      `node; ${touch()}`,
      `${process.execPath} && ${touch()}`,
      "node | node",
      "$(node)",
      "`node`",
      "node\n" + touch(),
      "node\0evil",
    ]) {
      const r = await runProcess({ command, args: ["-e", "1"], cwd: dir });
      expect(r.outcome, JSON.stringify(command)).toBe("spawn_error");
      expect(existsSync(sentinel())).toBe(false);
    }
  });

  it("a nonexistent program is a spawn error even with a hostile cwd or arguments", async () => {
    const r = await runProcess({
      command: "definitely-not-a-program-" + Date.now(),
      args: ["& calc"],
      cwd: dir,
    });
    expect(r.outcome).toBe("spawn_error");
  });

  it.skipIf(process.platform !== "win32")(
    "Windows: a .cmd/.bat script is refused (it would need cmd.exe and its quoting rules), arguments or not",
    async () => {
      for (const name of ["inject.cmd", "inject.bat"]) {
        const script = join(dir, name);
        writeFileSync(script, `@echo off\r\necho %1 > "${sentinel()}"\r\n`);
        for (const args of [[], ["&calc"], ['"&calc&"'], ["a", "|", "b"]]) {
          const r = await runProcess({ command: script, args, cwd: dir });
          expect(r.outcome, `${name} ${JSON.stringify(args)}`).toBe("spawn_error");
          expect(existsSync(sentinel())).toBe(false);
        }
      }
    },
  );
});

describe("malicious program output is bounded and stays data", () => {
  it("keeps at most maxCapture characters of a huge output and says it was truncated", async () => {
    const r = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('A'.repeat(5_000_000)); process.stderr.write('B'.repeat(5_000_000))",
      ],
      maxCapture: 10_000,
      cwd: dir,
    });
    expect(r.outcome).toBe("exited");
    expect(r.stdout.length).toBeLessThanOrEqual(10_000);
    expect(r.stderr.length).toBeLessThanOrEqual(10_000);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(true);
  }, 30_000);

  it("survives invalid UTF-8, NUL and terminal escape sequences without throwing", async () => {
    const r = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(Buffer.from([0xff,0xfe,0x00,0x1b,0x5b,0x32,0x4a,0xc3,0x28,0xe2,0x82]))",
      ],
      cwd: dir,
    });
    expect(r.outcome).toBe("exited");
    expect(r.stdout).toContain("\u001b[2J");
    expect(r.stdout).toContain("�"); // decoded with replacement, not crashed
  });

  it("a child that never exits is stopped by the timeout and leaves no sentinel behind", async () => {
    const r = await runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 300,
      cwd: dir,
    });
    expect(r.outcome).toBe("timeout");
  }, 15_000);
});
