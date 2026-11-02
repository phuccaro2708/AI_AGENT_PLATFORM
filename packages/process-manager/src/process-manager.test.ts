import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  ExecutableNotFoundError,
  createLineSplitter,
  resolveExecutable,
  runProcess,
  startProcess,
  unwrapNpmShim,
} from "./index.js";

const NODE = process.execPath;
const isWin = process.platform === "win32";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitUntil(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pm-"));
  dirs.push(d);
  return d;
};

describe("runProcess", () => {
  it("captures stdout/stderr and the exit code", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
    });
    expect(r).toMatchObject({ outcome: "exited", exitCode: 3 });
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  });

  it("passes arguments verbatim (no shell interpretation)", async () => {
    const nasty = 'a b; echo pwned & $(whoami) `id` | "quoted" %PATH%';
    const r = await runProcess({
      command: NODE,
      args: ["-e", "process.stdout.write(process.argv[1])", nasty],
    });
    expect(r.stdout).toBe(nasty);
  });

  it("streams chunks to callbacks and feeds stdin", async () => {
    const chunks: string[] = [];
    const r = await runProcess({
      command: NODE,
      args: ["-e", "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))"],
      stdin: "hello",
      onStdout: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toBe("HELLO");
    expect(r.stdout).toBe("HELLO");
  });

  it("truncates captured output but still streams everything", async () => {
    let streamed = 0;
    const r = await runProcess({
      command: NODE,
      args: ["-e", "process.stdout.write('x'.repeat(5000))"],
      maxCapture: 100,
      onStdout: (c) => (streamed += c.length),
    });
    expect(r.stdout).toHaveLength(100);
    expect(r.stdoutTruncated).toBe(true);
    expect(streamed).toBe(5000);
  });

  it("reports a missing executable as spawn_error without throwing", async () => {
    const r = await runProcess({ command: "definitely-not-a-real-command-xyz" });
    expect(r.outcome).toBe("spawn_error");
    expect(r.error).toMatch(/not found/i);
  });

  it("does not start when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runProcess({ command: NODE, args: ["-e", "1"], signal: ac.signal });
    expect(r.outcome).toBe("cancelled");
    expect(r.pid).toBeUndefined();
  });

  it("kills on timeout", async () => {
    const t0 = Date.now();
    const r = await runProcess({
      command: NODE,
      args: ["-e", "setTimeout(()=>{}, 60000)"],
      timeoutMs: 300,
    });
    expect(r.outcome).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(15000);
  });
});

describe("cancel kills the whole process tree", () => {
  it("leaves no grandchild behind", async () => {
    // parent node starts a grandchild node that sleeps, prints its pid, then sleeps itself.
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
      console.log("GRANDCHILD=" + g.pid);
      setTimeout(()=>{}, 60000);
    `;
    let grandchild = 0;
    const rp = startProcess({
      command: NODE,
      args: ["-e", script],
      onStdout: (c) => {
        const m = /GRANDCHILD=(\d+)/.exec(c);
        if (m) grandchild = Number(m[1]);
      },
    });
    expect(await waitUntil(() => grandchild > 0)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    await rp.cancel();
    const r = await rp.done;
    expect(r.outcome).toBe("cancelled");
    expect(await waitUntil(() => !alive(grandchild))).toBe(true);
    expect(alive(rp.pid ?? 0)).toBe(false);
  }, 30000);

  it("cancels via AbortSignal", async () => {
    const ac = new AbortController();
    const rp = startProcess({
      command: NODE,
      args: ["-e", "setTimeout(()=>{}, 60000)"],
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 200);
    const r = await rp.done;
    expect(r.outcome).toBe("cancelled");
  }, 30000);
});

describe("resolveExecutable (simulated Windows)", () => {
  const files = new Set([
    "c:\\tools\\claude.cmd",
    "c:\\tools\\codex.exe",
    "c:\\bin\\both.exe",
    "c:\\bin\\both.cmd",
  ]);
  const opts = {
    platform: "win32" as const,
    env: { PATH: "C:\\bin;C:\\tools", PATHEXT: ".EXE;.CMD" },
    // Windows file systems are case-insensitive; PATHEXT is conventionally upper-case.
    isFile: (p: string) => files.has(p.toLowerCase()),
  };
  it("finds .exe and flags .cmd as a shim", () => {
    const codex = resolveExecutable("codex", opts);
    expect(codex.path.toLowerCase()).toBe("c:\\tools\\codex.exe");
    expect(codex.kind).toBe("exe");
    const claude = resolveExecutable("claude", opts);
    expect(claude.path.toLowerCase()).toBe("c:\\tools\\claude.cmd");
    expect(claude.kind).toBe("shim");
  });
  it("honours PATH and PATHEXT order", () => {
    expect(resolveExecutable("both", opts).path.toLowerCase()).toBe("c:\\bin\\both.exe");
  });
  it("throws when missing", () => {
    expect(() => resolveExecutable("nope", opts)).toThrow(ExecutableNotFoundError);
  });
  it("ignores an extensionless npm sh-shim and picks the .cmd next to it (Legion layout)", () => {
    const legion = {
      platform: "win32" as const,
      env: { PATH: "C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      isFile: (p: string) => ["c:\\npm\\codex", "c:\\npm\\codex.cmd"].includes(p.toLowerCase()),
    };
    const r = resolveExecutable("codex", legion);
    expect(r.path.toLowerCase()).toBe("c:\\npm\\codex.cmd");
    expect(r.kind).toBe("shim");
  });
});

describe("unwrapNpmShim", () => {
  const body = (js: string) =>
    `@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n` +
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${js}" %*\r\n`;
  const mk = (js: string, create = true) => {
    const dir = tmp();
    const cmd = join(dir, "codex.cmd");
    writeFileSync(cmd, body(js));
    if (create) {
      mkdirSync(join(dir, "node_modules", "x", "bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "x", "bin", "codex.js"), "");
    }
    return { dir, cmd };
  };
  it("maps an npm .cmd shim to node + its script", () => {
    const { dir, cmd } = mk("node_modules\\x\\bin\\codex.js");
    const t = unwrapNpmShim({ path: cmd, kind: "shim" });
    expect(t?.kind).toBe("exe");
    expect(t?.path).toBe(process.execPath);
    expect(t?.prefixArgs).toEqual([join(dir, "node_modules", "x", "bin", "codex.js")]);
  });
  it("refuses a script outside the shim directory", () => {
    const { cmd } = mk("..\\evil.js", false);
    expect(unwrapNpmShim({ path: cmd, kind: "shim" })).toBeUndefined();
  });
  it("refuses a missing script and non-npm shims", () => {
    const { cmd } = mk("node_modules\\x\\bin\\codex.js", false);
    expect(unwrapNpmShim({ path: cmd, kind: "shim" })).toBeUndefined();
    const dir = tmp();
    const other = join(dir, "a.cmd");
    writeFileSync(other, "@echo off\r\necho hi\r\n");
    expect(unwrapNpmShim({ path: other, kind: "shim" })).toBeUndefined();
  });
});

describe.runIf(isWin)("Windows .cmd shims (real machine/runner)", () => {
  it("resolves a .cmd on PATH as a shim and runProcess refuses it", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "fakecli.cmd"), "@echo off\r\necho hi\r\n");
    const env = { ...process.env, PATH: `${dir};${process.env.PATH ?? ""}` };
    expect(resolveExecutable("fakecli", { env }).kind).toBe("shim");
    const r = await runProcess({ command: "fakecli", env });
    expect(r.outcome).toBe("spawn_error");
    expect(r.error).toMatch(/shim/i);
  });
  it("ASSUMPTION CHECK: this Node refuses .cmd with shell:false (records CVE-2024-27980 behaviour)", async () => {
    const dir = tmp();
    const cmd = join(dir, "x.cmd");
    writeFileSync(cmd, "@echo off\r\necho hi\r\n");
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      try {
        const c = spawn(cmd, [], { shell: false });
        c.on("error", (e) => resolve(e));
        c.on("close", () => resolve(null));
      } catch (e) {
        resolve(e as NodeJS.ErrnoException);
      }
    });
    expect(err?.code).toBe("EINVAL");
  });
});

describe("createLineSplitter", () => {
  it("splits LF/CRLF, joins split chunks, flushes the tail", () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.write('{"a":1}\r\n{"b"');
    s.write(":2}\n");
    s.write("tail");
    s.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', "tail"]);
  });
  it("handles multi-byte characters split across chunks", () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    const b = Buffer.from("xin chào\n");
    s.write(b.subarray(0, 7));
    s.write(b.subarray(7));
    expect(lines).toEqual(["xin chào"]);
  });
});
