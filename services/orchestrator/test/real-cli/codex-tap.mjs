// Transparent stdio proxy in front of the real `codex app-server --stdio`, used ONLY by the opt-in real-CLI checks
// (src/real-cli-gates.test.ts). The adapter starts `node codex-tap.mjs app-server --stdio`; this script starts the real
// codex (CODEX_TAP_TARGET = JSON {path, prefixArgs}) with the same arguments, forwards every byte both ways and
// appends each JSON line to CODEX_TAP_LOG as {dir: "c2s"|"s2c", line}.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

const target = JSON.parse(process.env.CODEX_TAP_TARGET ?? "null");
const logFile = process.env.CODEX_TAP_LOG;
if (!target || !logFile) {
  process.stderr.write("codex-tap: CODEX_TAP_TARGET and CODEX_TAP_LOG are required\n");
  process.exit(2);
}
const tap = (dir, line) =>
  appendFileSync(logFile, JSON.stringify({ t: Date.now(), dir, line }) + "\n");
const child = spawn(target.path, [...(target.prefixArgs ?? []), ...process.argv.slice(2)], {
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "inherit"],
});
createInterface({ input: process.stdin }).on("line", (line) => {
  tap("c2s", line);
  child.stdin.write(line + "\n");
});
createInterface({ input: child.stdout }).on("line", (line) => {
  tap("s2c", line);
  process.stdout.write(line + "\n");
});
child.stdin.on("error", () => undefined);
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => child.kill());
