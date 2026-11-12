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
      expect(() => jobWrapArgs({ path: NODE, jobMemLimitMb: bad })).toThrow(/--job-mem-limit-mb/);
      expect(() => jobWrapArgs({ path: NODE, timeoutSecs: bad })).toThrow(/--timeout-secs/);
    }
  });

  it("returns only the flags that were set, in a fixed order", () => {
    expect(jobWrapArgs({ path: NODE })).toEqual([]);
    expect(
      jobWrapArgs({ path: NODE, timeoutSecs: 9, memLimitMb: 512, jobMemLimitMb: 1024 }),
    ).toEqual(["--mem-limit-mb", "512", "--job-mem-limit-mb", "1024", "--timeout-secs", "9"]);
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
  it.skipIf(!haveBinary)(
    "cancel (AbortSignal) through the wrapper ends the program and its grandchild",
    async () => {
      const ac = new AbortController();
      // The program starts a grandchild node that would live 60 s and prints its pid.
      const script =
        "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});" +
        "console.log('gc='+c.pid);setTimeout(()=>{},60000)";
      const started = Date.now();
      let gcPid = 0;
      const p = runProcess({
        command: NODE,
        args: ["-e", script],
        jobWrap: { path: binary },
        signal: ac.signal,
        timeoutMs: 30_000,
        onStdout: (chunk: string) => {
          const m = /gc=(\d+)/.exec(chunk);
          if (m?.[1]) gcPid = Number(m[1]);
        },
      });
      while (!gcPid && Date.now() - started < 10_000) await new Promise((r) => setTimeout(r, 50));
      expect(gcPid).toBeGreaterThan(0);
      ac.abort();
      const r = await p;
      expect(r.outcome).toBe("cancelled");
      // Closing the job ends the tree asynchronously; a fixed 500 ms wait was too short under load. Poll instead.
      const alive = () => {
        try {
          process.kill(gcPid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const until = Date.now() + 10_000;
      while (alive() && Date.now() < until) await new Promise((r2) => setTimeout(r2, 100));
      expect(alive()).toBe(false); // grandchild is gone
    },
  );

  // R4: parent and child each commit 250 MB. A job-wide cap below the total refuses the child's
  // allocation (Windows fails the allocation, it does not kill the process); a roomy cap does not.
  it.skipIf(!haveBinary)(
    "--job-mem-limit-mb caps the SUM of the process tree, not each process",
    async () => {
      const child =
        "try{Buffer.alloc(250*1024*1024,1);console.log('CHILD_OK')}catch(e){console.log('CHILD_FAIL')}";
      const parent =
        "const b=Buffer.alloc(250*1024*1024,1);" +
        `const r=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{encoding:'utf8'});` +
        "console.log('PARENT_OK '+(r.stdout||'').trim()+' '+b[0])";
      const run = async (jobMemLimitMb: number | undefined, memLimitMb?: number) =>
        (
          await runProcess({
            command: NODE,
            args: ["-e", parent],
            jobWrap: {
              path: binary,
              ...(jobMemLimitMb ? { jobMemLimitMb } : {}),
              ...(memLimitMb ? { memLimitMb } : {}),
              timeoutSecs: 60,
            },
            timeoutMs: 90_000,
          })
        ).stdout;
      expect(await run(undefined)).toContain("PARENT_OK CHILD_OK");
      expect(await run(2000)).toContain("PARENT_OK CHILD_OK");
      // per-process cap 400 MB: each process stays under it, the 500 MB total is not seen
      expect(await run(undefined, 400)).toContain("PARENT_OK CHILD_OK");
      expect(await run(450)).toContain("PARENT_OK CHILD_FAIL");
    },
  );
});
