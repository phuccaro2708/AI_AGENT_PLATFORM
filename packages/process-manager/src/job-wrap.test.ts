import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jobWrapArgs, runProcess } from "./index.js";

/**
 * P4-4 (b) wiring: `startProcess({ jobWrap })` runs the program through `agent-job-wrap`.
 * The tests that need the real Windows binary run only when it is built (`cargo build --bin agent-job-wrap`,
 * or `AGENT_JOB_WRAP=<abs path>`); otherwise they are skipped, i.e. NOT_RUN, never faked.
 */
const NODE = process.execPath;
const binary =
  process.env["AGENT_JOB_WRAP"] ??
  fileURLToPath(
    new URL("../../../apps/desktop/src-tauri/target/debug/agent-job-wrap.exe", import.meta.url),
  );
const haveBinary = process.platform === "win32" && existsSync(binary);

describe("jobWrapArgs", () => {
  it("rejects a relative or missing wrapper path", () => {
    expect(() => jobWrapArgs({ path: "agent-job-wrap" })).toThrow(/absolute/);
    expect(() => jobWrapArgs({ path: NODE + ".missing" })).toThrow(/absolute/);
  });

  it("rejects limits that are not positive integers", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => jobWrapArgs({ path: NODE, memLimitMb: bad })).toThrow(/--mem-limit-mb/);
      expect(() => jobWrapArgs({ path: NODE, timeoutSecs: bad })).toThrow(/--timeout-secs/);
    }
  });

  it("returns only the flags that were set, in a fixed order", () => {
    expect(jobWrapArgs({ path: NODE })).toEqual([]);
    expect(jobWrapArgs({ path: NODE, timeoutSecs: 9, memLimitMb: 512 })).toEqual([
      "--mem-limit-mb",
      "512",
      "--timeout-secs",
      "9",
    ]);
  });
});

describe("startProcess with jobWrap", () => {
  it("reports spawn_error (does not run the program) when the wrapper path is unusable", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "console.log('ran')"],
      jobWrap: { path: "relative/agent-job-wrap.exe" },
    });
    expect(r.outcome).toBe("spawn_error");
    expect(r.stdout).toBe("");
  });

  it.skipIf(!haveBinary)(
    "runs the program through the real wrapper and keeps its stdout and exit code",
    async () => {
      const r = await runProcess({
        command: NODE,
        args: ["-e", "console.log('via-wrapper'); process.exit(7)"],
        jobWrap: { path: binary, memLimitMb: 2048, timeoutSecs: 60 },
      });
      expect(r.outcome).toBe("exited");
      expect(r.exitCode).toBe(7);
      expect(r.stdout.trim()).toBe("via-wrapper");
    },
  );

  it.skipIf(!haveBinary)("the wrapper's own timeout kills the program (exit 124)", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      jobWrap: { path: binary, timeoutSecs: 1 },
      timeoutMs: 30_000,
    });
    expect(r.exitCode).toBe(124);
  });
});
