// Stand-in for the agy CLI used by adapter tests. Behaviour is chosen by FAKE_MODE.
// Prompt arrives as the argv value after --print (agy 1.4.8 probe shape).
import process from "node:process";
import { setInterval } from "node:timers";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "ok";
const prompt = argv[argv.indexOf("--print") + 1] ?? "";
const usage = {
  input_tokens: 1,
  output_tokens: 1,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 2,
};
const step = (state, delta) => ({
  event: "step_update",
  step_update: { step_index: 2, state, step_type: "agent_response", text_delta: delta },
});
const result = (response, turns, status = "SUCCESS") => ({
  event: "result",
  result: { conversation_id: "c-1", status, response, num_turns: turns, usage },
});

if (mode === "garbage") {
  process.stdout.write(["this is not json", "{broken", ""].join("\n"));
  process.exit(0);
}
if (mode === "crash") {
  process.stderr.write("boom: something broke\n");
  process.exit(3);
}
out({ event: "init", conversation_id: "c-1", init: { cwd: process.cwd(), tools: [] } });
if (mode === "hang") {
  out(step("ACTIVE", "working"));
  setInterval(() => {}, 1000);
} else if (mode === "plan-empty") {
  // observed trap: exit 0, status SUCCESS, nothing ran
  out(result("", 0));
} else if (mode === "empty-response") {
  out(result("  \n", 1));
} else if (mode === "no-result") {
  out(step("ACTIVE", "partial"));
  process.exit(0);
} else if (mode === "args") {
  out(step("ACTIVE", JSON.stringify(argv)));
  out(result("args", 1));
} else {
  const text = mode === "echo" ? prompt : "ok";
  out(step("ACTIVE", text));
  out(step("DONE", "\n"));
  out(result(text + "\n", 1));
  out(step("ACTIVE", "late")); // must never be forwarded after the terminal line
}
