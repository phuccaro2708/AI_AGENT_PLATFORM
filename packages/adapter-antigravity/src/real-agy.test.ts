import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-studio/contracts";
import { AntigravityAdapter } from "./adapter.js";

/**
 * Real `agy`, a handful of tiny turns (P3-6). Skipped unless `AGENT_STUDIO_REAL_AGY=1`, because each case that
 * reaches the model spends tokens. Every case runs in a fresh empty temp directory outside the repository, and
 * every prompt says "no tools": that is a request, NOT permission enforcement (the adapter still refuses
 * `task.permissions`). Raw observations are written to `AGENT_STUDIO_REAL_AGY_OUT` when set.
 *
 *   $env:AGENT_STUDIO_REAL_AGY = "1"; pnpm exec vitest run packages/adapter-antigravity/src/real-agy.test.ts
 */
const ON = process.env["AGENT_STUDIO_REAL_AGY"] === "1";
const OUT = process.env["AGENT_STUDIO_REAL_AGY_OUT"];

const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), "agy-probe-")));
/** Best effort: agy may still hold the directory for a moment on Windows (EPERM); a temp dir left behind is harmless. */
const cleanup = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};
const save = (name: string, data: unknown) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
};
const agyProcesses = (): number => {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq agy.exe", "/FO", "CSV", "/NH"], {
    shell: false,
    encoding: "utf8",
  });
  return r.stdout.split(/\r?\n/).filter((l) => l.toLowerCase().includes("agy.exe")).length;
};
async function run(
  adapter: AntigravityAdapter,
  prompt: string,
  cwd: string,
  opts: { cancelAfterMs?: number } = {},
) {
  const ac = new AbortController();
  const events: AgentEvent[] = [];
  const started = Date.now();
  const timer =
    opts.cancelAfterMs !== undefined ? setTimeout(() => ac.abort(), opts.cancelAfterMs) : undefined;
  for await (const e of adapter.execute({
    id: `t-${started}`,
    workflowId: "w",
    agentId: "agy",
    prompt,
    cwd,
    signal: ac.signal,
  } as never)) {
    events.push(e);
  }
  if (timer) clearTimeout(timer);
  return { events, ms: Date.now() - started };
}
const text = (ev: AgentEvent[]) =>
  ev
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.content)
    .join("");

describe.skipIf(!ON)("real agy through the adapter", () => {
  it("raw run: cwd of the child is honoured, multi-line prompt arrives as one argument", async () => {
    const cwd = fresh();
    const prompt =
      'Do not use any tools.\nReply with exactly these two lines and nothing else:\nline-one "quoted" & | % $HOME\nline-two';
    const out = await new Promise<string>((resolve, reject) => {
      const c = spawn(
        "agy",
        ["--print", prompt, "--output-format", "stream-json", "--print-timeout", "90s"],
        {
          cwd,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let s = "";
      c.stdout.on("data", (b: Buffer) => (s += b.toString()));
      c.once("error", reject);
      c.once("close", (code) => resolve(`${s}\n#exit:${String(code)}`));
    });
    save("raw-multiline.ndjson", out);
    const lines = out.split("\n").filter((l) => l.startsWith("{"));
    const init = JSON.parse(lines.find((l) => l.includes('"event":"init"'))!);
    const result = JSON.parse(lines.find((l) => l.includes('"event":"result"'))!);
    console.log(
      `init.cwd=${init.init.cwd} expected=${cwd} permission_mode=${init.init.permission_mode}`,
    );
    console.log(
      `result.status=${result.result.status} turns=${result.result.num_turns} response=${JSON.stringify(result.result.response)}`,
    );
    expect(String(init.init.cwd).toLowerCase()).toBe(cwd.toLowerCase());
    cleanup(cwd);
  }, 150_000);

  it("adapter: streams text and ends `completed` for a multi-line prompt with special characters", async () => {
    const cwd = fresh();
    const { events, ms } = await run(
      new AntigravityAdapter({ extraArgs: ["--print-timeout", "90s"] }),
      'Do not use any tools.\nReply with exactly these two lines and nothing else:\nline-one "quoted" & | % $HOME\nline-two',
      cwd,
    );
    save("adapter-multiline.json", { events, ms });
    console.log(
      `adapter multiline: ${events.map((e) => e.type).join(",")} in ${ms} ms; text=${JSON.stringify(text(events))}`,
    );
    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(text(events)).toContain("line-one");
    expect(text(events)).toContain("line-two");
    cleanup(cwd);
  }, 150_000);

  it("error: a bad model is reported as `error`, not success", async () => {
    const cwd = fresh();
    const { events, ms } = await run(
      new AntigravityAdapter({
        extraArgs: ["--model", "no-such-model-xyz", "--print-timeout", "60s"],
      }),
      "Do not use any tools. Reply with: ok",
      cwd,
    );
    save("adapter-bad-model.json", { events, ms });
    console.log(`bad model: ${JSON.stringify(events)} in ${ms} ms`);
    expect(events.at(-1)?.type).toBe("error");
    cleanup(cwd);
  }, 150_000);

  it("error: a working directory that does not exist is `could not start agy`", async () => {
    const { events } = await run(
      new AntigravityAdapter(),
      "ok",
      join(tmpdir(), "agy-probe-missing-dir-xyz"),
    );
    save("adapter-missing-cwd.json", events);
    console.log(`missing cwd: ${JSON.stringify(events)}`);
    expect(events.at(-1)?.type).toBe("error");
  }, 30_000);

  it("timeout: --print-timeout 1s ends as `error` (exit 0 with an empty result is not success)", async () => {
    const cwd = fresh();
    const { events, ms } = await run(
      new AntigravityAdapter({ extraArgs: ["--print-timeout", "1s"] }),
      "Do not use any tools. Write the numbers from 1 to 400, one per line, with a short sentence after each.",
      cwd,
    );
    save("adapter-timeout.json", { events, ms });
    console.log(
      `timeout: ${JSON.stringify(events.map((e) => (e.type === "text" ? "text" : e)))} in ${ms} ms`,
    );
    expect(events.at(-1)?.type).toBe("error");
    cleanup(cwd);
  }, 150_000);

  it("cancel: aborting stops the process and leaves no agy.exe behind", async () => {
    const cwd = fresh();
    const before = agyProcesses();
    const { events, ms } = await run(
      new AntigravityAdapter(),
      "Do not use any tools. Write the numbers from 1 to 400, one per line, with a short sentence after each.",
      cwd,
      { cancelAfterMs: 4000 },
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = agyProcesses();
    save("adapter-cancel.json", { events, ms, before, after });
    console.log(
      `cancel: ${JSON.stringify(events.map((e) => (e.type === "text" ? "text" : e)))} in ${ms} ms; agy.exe before=${before} after=${after}`,
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("cancelled"),
    });
    expect(ms).toBeLessThan(20_000);
    expect(after).toBeLessThanOrEqual(before);
    cleanup(cwd);
  }, 60_000);
});
