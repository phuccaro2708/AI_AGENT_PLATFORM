import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

/**
 * T12 / R3: the text of the native confirmation dialog is written by the sidecar from its own state.
 * `confirm.describe` is read-only, refuses calls that could not succeed, and never echoes secrets.
 */
const SECRET = "sk-ant-test-SECRETSECRETSECRETSECRET";
let dir: string;
let svc: SidecarService;
let n = 0;

const open = () =>
  new SidecarService(
    { dbPath: join(dir, "s.db"), secrets: { claude: { ANTHROPIC_API_KEY: SECRET }, codex: {} } },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );

const describeCall = async (method: string, params: unknown) => {
  const { response } = await svc.handle({
    id: ++n,
    method: "confirm.describe",
    params: { method, params },
  });
  return response as { result?: { title: string; message: string }; error?: { message: string } };
};

const sql = (q: string, ...a: unknown[]) => svc.db.$client.prepare(q).run(...a);
const state = (id: string) =>
  svc.db.$client.prepare("select state from tasks where id=?").pluck().get(id);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-confirm-"));
  svc = open();
  const ts = new Date().toISOString();
  sql("insert into projects (id,name,root_path,created_at) values ('p','n','r',?)", ts);
  sql("insert into workflows (id,project_id,state,created_at) values ('w','p','running',?)", ts);
  sql(
    "insert into tasks (id,workflow_id,state,created_at,updated_at) values ('t1','w','waiting_approval',?,?)",
    ts,
    ts,
  );
  sql(
    "insert into approvals (id,task_id,state,request_json,created_at) values ('a1','t1','pending',?,?)",
    JSON.stringify({ command: "rm -rf build", token: SECRET }),
    ts,
  );
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("confirm.describe", () => {
  it("describes an approval from the stored request, not from the caller, and masks secrets", async () => {
    const r = await describeCall("approvals.resolve", {
      approvalId: "a1",
      decision: "approved",
      note: "looks fine",
    });
    expect(r.error).toBeUndefined();
    expect(r.result!.title).toContain("APPROVE");
    expect(r.result!.message).toContain("rm -rf build"); // from the database
    expect(r.result!.message).toContain("Task: t1");
    expect(r.result!.message).toContain("looks fine");
    expect(r.result!.message).not.toContain(SECRET);
    const d = await describeCall("approvals.resolve", { approvalId: "a1", decision: "denied" });
    expect(d.result!.title).toContain("DENY");
  });

  it("is read-only: describing changes nothing", async () => {
    await describeCall("approvals.resolve", { approvalId: "a1", decision: "approved" });
    expect(state("t1")).toBe("waiting_approval");
    expect(svc.db.$client.prepare("select state from approvals where id='a1'").pluck().get()).toBe(
      "pending",
    );
  });

  it("refuses what the real call would refuse, so the shell shows no dialog", async () => {
    for (const [method, params] of [
      ["approvals.resolve", { approvalId: "nope", decision: "approved" }],
      ["approvals.resolve", { approvalId: "a1", decision: "maybe" }], // bad decision
      ["tasks.resolveReconciliation", { taskId: "ghost", decision: "completed", note: "checked" }],
      ["tasks.resolveReconciliation", { taskId: "t1", decision: "completed", note: "x" }], // note too short
      ["recovery.resolve", { taskId: "ghost", action: "abandon", note: "checked" }],
      ["agents.setSettings", { provider: "gemini", settings: null }],
      ["health", {}], // not a confirmable method
      ["shutdown", undefined],
    ] as const) {
      const r = await describeCall(method, params);
      expect(r.error, `${method} ${JSON.stringify(params)}`).toBeDefined();
      expect(r.result).toBeUndefined();
    }
    // an answered approval is no longer something to confirm
    sql("update approvals set state='approved' where id='a1'");
    expect(
      (await describeCall("approvals.resolve", { approvalId: "a1", decision: "approved" })).error
        ?.message,
    ).toContain("already approved");
  });

  it("describes the reconciliation and recovery decisions with the task's own state", async () => {
    sql("update tasks set state='needs_reconciliation' where id='t1'");
    const rec = await describeCall("tasks.resolveReconciliation", {
      taskId: "t1",
      decision: "requeue",
      note: "checked the worktree",
    });
    expect(rec.result!.message).toContain("needs_reconciliation");
    expect(rec.result!.message).toContain("requeue");
    expect(rec.result!.message).toContain("run again");
    const rv = await describeCall("recovery.resolve", {
      taskId: "t1",
      action: "abandon",
      note: "checked the worktree",
    });
    expect(rv.error).toBeUndefined();
    expect(rv.result!.message).toContain("abandon");
    expect(rv.result!.message).toContain("Evidence:");
  });

  it("shows the program an agent setting would launch, with env NAMES but never values", async () => {
    const r = await describeCall("agents.setSettings", {
      provider: "claude",
      settings: { command: "C:\\tools\\claude.exe", args: ["--x"], env: { MY_VAR: "hunter2" } },
    });
    expect(r.result!.message).toContain("claude.exe");
    expect(r.result!.message).toContain("MY_VAR");
    expect(r.result!.message).not.toContain("hunter2");
    const reset = await describeCall("agents.setSettings", { provider: "codex", settings: null });
    expect(reset.result!.title).toContain("Reset");
  });

  it("keeps the dialog body short whatever is stored", async () => {
    sql(
      "update approvals set request_json=? where id='a1'",
      JSON.stringify({ blob: "A".repeat(100_000) }),
    );
    const r = await describeCall("approvals.resolve", {
      approvalId: "a1",
      decision: "approved",
      note: "n".repeat(2000),
    });
    expect(r.result!.message.length).toBeLessThan(2000);
  });
});

describe("the shell's list of confirmed methods", () => {
  it("names exactly the methods confirm.describe is written for", () => {
    const libRs = readFileSync(
      fileURLToPath(new URL("../../../apps/desktop/src-tauri/src/lib.rs", import.meta.url)),
      "utf8",
    );
    const block = /const CONFIRMED_METHODS: &\[&str\] = &\[([\s\S]*?)\];/.exec(libRs)?.[1] ?? "";
    const confirmed = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(confirmed.sort()).toEqual([
      "agents.setSettings",
      "approvals.resolve",
      "recovery.resolve",
      "tasks.resolveReconciliation",
    ]);
    expect(libRs).toContain('const DESCRIBE_METHOD: &str = "confirm.describe"');
  });
});
