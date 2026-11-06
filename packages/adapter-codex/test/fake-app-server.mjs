// Stand-in for `codex app-server --stdio` used by adapter tests: line-delimited JSON-RPC WITHOUT a "jsonrpc"
// field, long-lived (it does NOT exit after the turn, like the real server). Behaviour comes from FAKE_SCRIPT, a
// JSON array run after `turn/start`:
//   {"notify": {...}}                        send a notification
//   {"request": {method, params}, "id": 7}   send a server -> client request and wait for the reply (id optional)
//   {"sleep": ms}                            wait
//   {"exit": code}                           die (lost connection)
//   {"hang": true}                           never finish
// Every line received from the client is appended to FAKE_LOG so tests can inspect the exact traffic.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";
import { setInterval, setTimeout } from "node:timers";

const log = process.env.FAKE_LOG;
const script = JSON.parse(process.env.FAKE_SCRIPT ?? "[]");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const waiting = new Map();
let nextId = 100;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (log) appendFileSync(log, line + "\n");
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({ id: m.id, result: { userAgent: "fake", codexHome: "<HOME>", platformFamily: "unix" } });
  } else if (m.method === "thread/start") {
    send({ id: m.id, result: { thread: { id: "thr-1" } } });
  } else if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    void run();
  } else if (m.id !== undefined && m.method === undefined) {
    waiting.get(m.id)?.(m);
  }
});
rl.on("close", () => process.exit(0));

async function run() {
  for (const step of script) {
    if (step.notify) {
      send(step.notify);
    } else if (step.request) {
      const id = step.id ?? nextId++;
      const reply = new Promise((r) => waiting.set(id, r));
      send({ id, ...step.request });
      await reply;
    } else if (step.sleep) {
      await new Promise((r) => setTimeout(r, step.sleep));
    } else if (step.exit !== undefined) {
      process.exit(step.exit);
    } else if (step.hang) {
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
  }
  send({
    method: "turn/completed",
    params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } },
  });
}

setInterval(() => {}, 1000); // stay alive until the client closes stdin or kills us
