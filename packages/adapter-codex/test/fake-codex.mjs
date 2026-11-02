// Stand-in for the codex CLI used by adapter tests. Behaviour is chosen by FAKE_MODE.
import process from "node:process";
import { setInterval } from "node:timers";
import { readFileSync } from "node:fs";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const prompt = readFileSync(0, "utf8");
const mode = process.env.FAKE_MODE ?? "ok";
const msg = (id, text) => ({ type: "item.completed", item: { id, type: "agent_message", text } });
const done = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };

if (mode === "garbage") {
  process.stdout.write(["this is not json", "{broken", ""].join("\n"));
  process.exit(0);
}
if (mode === "crash") {
  process.stderr.write("boom: something broke\n");
  process.exit(3);
}
out({ type: "thread.started", thread_id: "thr-1" });
out({ type: "turn.started" });
if (mode === "hang") {
  out(msg("item_0", "working"));
  setInterval(() => {}, 1000);
} else if (mode === "tools") {
  const cmd = { id: "item_1", type: "command_execution", command: "echo hi" };
  out({
    type: "item.started",
    item: { ...cmd, aggregated_output: "", exit_code: null, status: "in_progress" },
  });
  out({
    type: "item.completed",
    item: { ...cmd, aggregated_output: "hi\n", exit_code: 0, status: "completed" },
  });
  out(msg("item_2", "done"));
  out(done);
} else if (mode === "unfinished") {
  out({
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "x", status: "in_progress" },
  });
  process.exit(1);
} else if (mode === "args") {
  out(msg("item_0", JSON.stringify(process.argv.slice(2))));
  out(done);
} else if (mode === "failed") {
  out({ type: "error", message: "model not available" });
  out({ type: "turn.failed", error: { message: "model not available" } });
} else {
  out(msg("item_0", mode === "echo" ? prompt : "ok"));
  out(done);
  out(msg("item_9", "late")); // must never be forwarded after the terminal line
}
