import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { verifyDiagnostics } from "@agent-studio/diagnostics";
import type { SidecarEvent } from "@agent-studio/contracts";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

const SECRET = "sk-live-0123456789abcdefSECRET";
const SETTINGS_SECRET = "tok-from-settings-98765432";

let dir: string;
let svc: SidecarService;
let events: SidecarEvent[];
let logged: string;
let n = 0;

const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
};

/** Every file under `root`, as text. */
function allText(root: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return out.join("\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-diag-"));
  events = [];
  logged = "";
  svc = new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      onEvent: (e) => events.push(e),
      secrets: { claude: { ANTHROPIC_API_KEY: SECRET }, codex: {} },
    },
    createLogger({
      name: "t",
      destination: new Writable({
        write: (c, _e, cb) => {
          logged += String(c);
          cb();
        },
      }),
    }),
  );
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("diagnostics.export", () => {
  it("writes a bundle that opens, verifies and lists its files", async () => {
    await call("runStub", { prompt: "hello" });
    const r = await call<{
      dir: string;
      verified: boolean;
      problems: string[];
      files: { path: string }[];
    }>("diagnostics.export");
    expect(r.verified).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.dir.startsWith(join(dir, "diagnostics"))).toBe(true);
    expect(verifyDiagnostics(r.dir)).toEqual({ ok: true, problems: [] });
    const names = r.files.map((f) => f.path);
    expect(names).toEqual(expect.arrayContaining(["versions.json", "config.json"]));
    expect(names.some((p) => p.startsWith("attachments/"))).toBe(true);
    const config = JSON.parse(readFileSync(join(r.dir, "config.json"), "utf8")) as {
      tasksByState: Record<string, number>;
    };
    expect(config.tasksByState.completed).toBe(1);
  });

  it("leaves no known secret in DB, log, IPC answers, events or the bundle", async () => {
    // A task whose output echoes the secret, a log file that was written unmasked, and a secret stored in settings env.
    svc.db.$client
      .prepare(
        "insert into agent_settings (provider,command,args_json,env_json,verified_at,updated_at) values ('claude','claude','[]',?,?,?)",
      )
      .run(
        JSON.stringify({ MY_TOKEN: SETTINGS_SECRET }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sidecar.log"),
      `{"level":30,"msg":"started with ${SECRET}"}\nplain line ${SETTINGS_SECRET}\n`,
    );
    const run = await call<{ taskId: string }>("runStub", { prompt: `use ${SECRET} please` });
    const q = JSON.stringify(await call("logs.query", { taskId: run.taskId }));
    const hist = JSON.stringify(await call("tasks.history", {}));
    const out = await call<{ dir: string }>("diagnostics.export");
    const bundle = allText(out.dir);
    const reply = JSON.stringify(out);

    expect(bundle).toContain("[REDACTED]"); // the secrets did appear in the inputs and were masked
    for (const s of [SECRET, SETTINGS_SECRET]) {
      expect(bundle).not.toContain(s);
      expect(reply).not.toContain(s);
    }
    // The exact-value redactor already in place: DB rows, IPC answers, pushed events and the process log.
    const dbText = JSON.stringify(
      svc.db.$client.prepare("select payload_json from messages").all(),
    );
    expect(dbText).toContain("[REDACTED]"); // the prompt carried the secret, the stored copy is masked
    for (const text of [dbText, q, hist, JSON.stringify(events), logged]) {
      expect(text).not.toContain(SECRET);
    }
  });

  it("does not let the caller choose where it writes (no params accepted)", async () => {
    const { response } = await svc.handle({
      id: 99,
      method: "diagnostics.export",
      params: { outDir: "C:/anywhere" },
    });
    expect("error" in response).toBe(false);
    const r = (response as { result: { dir: string } }).result;
    expect(r.dir.startsWith(join(dir, "diagnostics"))).toBe(true);
  });
});
