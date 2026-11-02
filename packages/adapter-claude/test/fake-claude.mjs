// Stand-in for the claude CLI used by adapter tests. Behaviour is chosen by FAKE_MODE.
import process from "node:process";
import { setInterval } from "node:timers";
import { readFileSync } from "node:fs";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const prompt = readFileSync(0, "utf8");
const mode = process.env.FAKE_MODE ?? "ok";
const init = { type: "system", subtype: "init", session_id: "sess-1" };
const text = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const done = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "sess-1",
  num_turns: 1,
};

if (mode === "crash") {
  process.stderr.write("boom: something broke\n");
  process.exit(3);
}
out({ type: "system", subtype: "hook_started", hook_name: "x" }); // noise that must be ignored
out(init);
if (mode === "hang") {
  out(text("working"));
  setInterval(() => {}, 1000);
} else if (mode === "tools") {
  out({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.txt" } }] },
  });
  out({ type: "user", message: { content: [{ type: "tool_result", content: "file body" }] } });
  out(text("done"));
  out(done);
} else if (mode === "args") {
  out(text(JSON.stringify(process.argv.slice(2))));
  out(done);
} else {
  out(text(mode === "echo" ? prompt : "ok"));
  out(done);
  out(text("late")); // must never be forwarded after the result
}
