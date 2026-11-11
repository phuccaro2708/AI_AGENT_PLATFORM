import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "@agent-studio/orchestrator";
import { NodeResourceSource } from "@agent-studio/resource-monitor";

/**
 * MANUAL, OPT-IN. Real sidecar + REAL measurements (OS RAM, `nvidia-smi` whole-GPU VRAM) + real local Ollama.
 * `AGENT_STUDIO_REAL_PRESSURE=<model already pulled>`; nothing is pulled and the model is unloaded at the end.
 * Thresholds are set relative to what this machine reads right now, then a real task loads the model (VRAM) or
 * the RAM band is set under the current RAM use. Each REAL_PRESSURE line is what was observed.
 * This exercises the backend (admission, monitor, scheduler); it is NOT the Tauri UI.
 */
const MODEL = process.env["AGENT_STUDIO_REAL_PRESSURE"]?.trim();
const OUT = process.env["AGENT_STUDIO_REAL_OLLAMA_OUT"]?.trim();
const BASE = "http://127.0.0.1:11434";
const note = (o: unknown) => {
  const line = `REAL_PRESSURE ${JSON.stringify(o)}`;
  console.log(line);
  if (OUT) appendFileSync(OUT, `${line}\n`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = createLogger({
  name: "t",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

let dir: string;
let svc: SidecarService | undefined;
let n = 0;
type R = { result?: Record<string, any>; error?: { message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (method: string, params?: unknown): Promise<R> =>
  (await svc!.handle({ id: ++n, method, ...(params ? { params } : {}) })).response as R;

const unload = () =>
  fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
  }).then((r) => r.arrayBuffer());

async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

afterEach(async () => {
  svc?.close();
  svc = undefined;
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (MODEL) await unload().catch(() => undefined);
});

describe.skipIf(!MODEL)("real RAM/VRAM pressure on a real sidecar (opt-in)", () => {
  async function open() {
    dir = mkdtempSync(join(tmpdir(), "as-pressure-"));
    svc = new SidecarService(
      {
        dbPath: join(dir, "s.db"),
        schedulerIntervalMs: 100,
        resourceSource: new NodeResourceSource(),
        resourceSampleMs: 500,
        ollama: { baseUrl: BASE, model: MODEL!, numPredict: 128, idleTimeoutMs: 120_000 },
      },
      quiet,
    );
    const root = join(dir, "proj");
    mkdirSync(root, { recursive: true });
    const p = await call("projects.create", { name: "p", rootPath: root });
    const w = await call("workflows.create", { projectId: p.result!["projectId"] });
    return w.result!["workflowId"] as string;
  }
  const start = async (workflowId: string) => {
    const r = await call("workflows.start", {
      workflowId,
      agentId: "ollama",
      prompt: "Reply with the single word: ok",
    });
    expect(r.error).toBeUndefined();
    return r.result!["taskId"] as string;
  };
  const state = async (taskId: string) => (await call("queryTask", { taskId })).result!["state"];
  const status = async () => (await call("resources.get")).result!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const save = async (mutate: (s: any) => void) => {
    const cur = (await status()).settings;
    mutate(cur);
    const r = await call("resources.set", { settings: cur });
    expect(r.error).toBeUndefined();
  };

  it("VRAM: a loaded model pauses the next task; unloading it lets the task run", async () => {
    const wf = await open();
    const base = await until("a GPU reading", async () => {
      const s = await status();
      return s.status.gpu ? s : undefined;
    });
    const used = (g: { usedBytes: number; totalBytes: number }) =>
      (100 * g.usedBytes) / g.totalBytes;
    const idle = used(base.status.gpu);
    await save((s) => {
      s.thresholds.vram = { reduceAt: Math.round(idle) + 12, pauseAt: Math.round(idle) + 20 };
    });
    const t1 = await start(wf);
    await until("task 1 completed", async () =>
      (await state(t1)) === "completed" ? true : undefined,
    );
    // keep_alive left the model in VRAM: the GPU is now above the pause line
    const paused = await until("monitor paused", async () => {
      const s = await status();
      return s.status.monitor.level === "paused" ? s : undefined;
    });
    const t2 = await start(wf);
    await sleep(3000);
    const whilePaused = { t2: await state(t2), queued: (await status()).status.queued };
    await unload();
    const t0 = Date.now();
    await until("task 2 completed", async () =>
      (await state(t2)) === "completed" ? true : undefined,
    );
    const after = await status();
    note({
      case: "vram",
      idlePercent: Math.round(idle),
      band: after.settings.thresholds.vram,
      pausedReasons: paused.status.monitor.reasons,
      pausedVramPercent: paused.status.monitor.vramPercent,
      task2WhilePaused: whilePaused,
      recoveredToCompletedMs: Date.now() - t0,
      levelAfter: after.status.monitor.level,
    });
    expect(whilePaused.t2).toBe("queued");
  }, 300_000);

  it("RAM: a band under the current RAM use holds tasks back; restoring it lets them run", async () => {
    const wf = await open();
    const s0 = await until("a memory reading", async () => {
      const s = await status();
      return typeof s.status.monitor.memoryPercent === "number" ? s : undefined;
    });
    const mem = Math.floor(s0.status.monitor.memoryPercent);
    const restore = s0.settings.thresholds.memory;
    await save((s) => {
      s.thresholds.memory = { reduceAt: Math.max(1, mem - 20), pauseAt: Math.max(2, mem - 10) };
    });
    const paused = await until("monitor paused", async () => {
      const s = await status();
      return s.status.monitor.level === "paused" ? s : undefined;
    });
    const t = await start(wf);
    await sleep(3000);
    const whilePaused = await state(t);
    await save((s) => {
      s.thresholds.memory = restore;
    });
    const t0 = Date.now();
    await until("task completed", async () =>
      (await state(t)) === "completed" ? true : undefined,
    );
    note({
      case: "ram",
      memoryPercentAtStart: mem,
      pausedReasons: paused.status.monitor.reasons,
      taskWhilePaused: whilePaused,
      recoveredToCompletedMs: Date.now() - t0,
    });
    expect(whilePaused).toBe("queued");
  }, 300_000);
});
