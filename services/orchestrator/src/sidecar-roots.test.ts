import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

let dir: string;
let svc: SidecarService;
let n = 0;
const open = () =>
  new SidecarService(
    { dbPath: join(dir, "data", "s.db") },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
const call = async (method: string, params?: unknown) => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  return response as { result?: Record<string, unknown>; error?: { message: string } };
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "as-roots-")));
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "app"));
  svc = open();
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("projects.create root policy", () => {
  it("stores the canonical path and refuses the same folder twice", async () => {
    const a = await call("projects.create", { name: "a", rootPath: join(dir, "app") + "/" });
    expect(a.result?.projectId).toBeTruthy();
    const listed = (await call("projects.list")).result?.projects as { rootPath: string }[];
    expect(listed.map((p) => p.rootPath)).toEqual([join(dir, "app")]);
    const again = await call("projects.create", { name: "b", rootPath: join(dir, "app") });
    expect(again.error?.message).toMatch(/already the project "a"/);
  });

  it("refuses a missing folder, a drive root and the folder holding the database", async () => {
    for (const [rootPath, re] of [
      [join(dir, "missing"), /does not exist/],
      [join(dir, "data"), /database/],
      ["relative/dir", /absolute/],
    ] as const) {
      const r = await call("projects.create", { name: "x", rootPath });
      expect(r.error?.message).toMatch(re);
    }
    expect(((await call("projects.list")).result?.projects as unknown[]).length).toBe(0);
  });

  it("refuses to start work in a project whose folder disappeared", async () => {
    const p = await call("projects.create", { name: "a", rootPath: join(dir, "app") });
    const w = await call("workflows.create", { projectId: p.result?.projectId });
    rmSync(join(dir, "app"), { recursive: true });
    const r = await call("workflows.start", {
      workflowId: w.result?.workflowId,
      agentId: "stub",
      prompt: "hi",
    });
    expect(r.error?.message).toMatch(/Project folder unusable.*does not exist/);
    const pr = await call("workflows.startPeerReview", {
      workflowId: w.result?.workflowId,
      implementerAgent: "stub",
      reviewerAgent: "stub",
      goal: "g",
    });
    expect(pr.error?.message).toMatch(/Project folder unusable/);
  });
});
