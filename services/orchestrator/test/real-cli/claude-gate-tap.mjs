// Transparent stdio proxy in front of the REAL gate (the bundled sidecar started with `--permission-gate --policy …`),
// used ONLY by the opt-in real-CLI checks (src/real-cli-gates.test.ts). claude starts
// `node claude-gate-tap.mjs <logFile> <bundle> --permission-gate --policy <b64>`; this script starts
// `node <bundle> --permission-gate --policy <b64>` (the production code), forwards every line both ways and appends
// {t, dir: "c2s"|"s2c", line} to <logFile>. The log path comes from argv, not env: whether an MCP server started by
// claude inherits env was never probed (docs/ASSUMPTIONS.md).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

const [logFile, bundle, ...rest] = process.argv.slice(2);
if (!logFile || !bundle) {
  process.stderr.write("claude-gate-tap: <logFile> <bundle> required\n");
  process.exit(2);
}
const tap = (dir, line) =>
  appendFileSync(logFile, JSON.stringify({ t: Date.now(), dir, line }) + "\n");
tap("start", "");
const child = spawn(process.execPath, [bundle, ...rest], {
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "inherit"],
});
// Optional hold (A1, gate-hang check): when `<logFile>.hold` exists, the FIRST `tools/call` is logged and withheld
// until `<logFile>.go` exists, so the test can freeze the real gate process BEFORE it receives the request.
let held = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  tap("c2s", line);
  if (!held && existsSync(logFile + ".hold") && line.includes('"tools/call"')) {
    held = true;
    tap("held", "");
    const timer = setInterval(() => {
      if (!existsSync(logFile + ".go")) return;
      clearInterval(timer);
      child.stdin.write(line + "\n");
    }, 50);
    return;
  }
  child.stdin.write(line + "\n");
});
createInterface({ input: child.stdout }).on("line", (line) => {
  tap("s2c", line);
  process.stdout.write(line + "\n");
});
process.stdin.on("end", () => child.stdin.end());
child.stdin.on("error", () => undefined);
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => child.kill());
