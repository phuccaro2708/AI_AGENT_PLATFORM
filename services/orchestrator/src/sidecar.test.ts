import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

let dir: string;
let svc: SidecarService;
const sink = new Writable({ write: (_c, _e, cb) => cb() });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-studio-sidecar-"));
  svc = new SidecarService(
    { dbPath: join(dir, "s.db") },
    createLogger({ name: "t", destination: sink }),
  );
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SidecarService", () => {
  it("answers health with WAL journal mode", async () => {
    const { response } = await svc.handle({ id: 1, method: "health" });
    expect(response).toMatchObject({ id: 1, result: { journalMode: "wal" } });
  });
  it("runs the stub and persists, then queryTask sees it", async () => {
    const run = await svc.handle({ id: 2, method: "runStub", params: { prompt: "hi" } });
    const result = (run.response as { result: { taskId: string; finalState: string } }).result;
    expect(result.finalState).toBe("completed");
    const q = await svc.handle({ id: 3, method: "queryTask", params: { taskId: result.taskId } });
    expect(q.response).toMatchObject({ id: 3, result: { state: "completed" } });
  });
  it("rejects invalid requests without throwing", async () => {
    const { response } = await svc.handle({ id: 4, method: "nope" });
    expect(response).toMatchObject({ id: 4, error: { message: "invalid request" } });
  });
  it("on restart, a task left running becomes needs_reconciliation and health reports it (D4)", async () => {
    const seeded = svc.db.$client;
    const repoSql = (q: string, ...a: unknown[]) => seeded.prepare(q).run(...a);
    const ts = new Date().toISOString();
    repoSql("insert into projects (id,name,root_path,created_at) values ('p','n','r',?)", ts);
    repoSql(
      "insert into workflows (id,project_id,state,created_at) values ('w','p','pending',?)",
      ts,
    );
    repoSql(
      "insert into tasks (id,workflow_id,state,created_at,updated_at) values ('t','w','running',?,?)",
      ts,
      ts,
    );
    svc.close(); // simulate a crash: the row stays `running`

    svc = new SidecarService(
      { dbPath: join(dir, "s.db") },
      createLogger({ name: "t", destination: sink }),
    );
    const q = await svc.handle({ id: 6, method: "queryTask", params: { taskId: "t" } });
    expect(q.response).toMatchObject({ result: { state: "needs_reconciliation" } });
    const h = await svc.handle({ id: 7, method: "health" });
    expect(h.response).toMatchObject({ result: { recoveredTasks: 1 } });
  });
  it("flags shutdown", async () => {
    expect((await svc.handle({ id: 5, method: "shutdown" })).shutdown).toBe(true);
  });
});
