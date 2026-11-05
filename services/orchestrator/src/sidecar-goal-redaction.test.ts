import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentEvent } from "@agent-studio/contracts";
import type { AgentAdapter } from "@agent-studio/agent-core";
import { createLogger } from "@agent-studio/shared-utils";
import { SidecarService } from "./sidecar.js";

const SECRET = "sk-ant-test-goalleak-0123456789"; // pragma: allowlist secret

class Quiet implements AgentAdapter {
  constructor(readonly id: string) {}
  async detect() {
    return true;
  }
  async capabilities() {
    return [];
  }
  async cancel() {}
  async *execute(): AsyncIterable<AgentEvent> {
    yield { type: "text", content: '{"verdict":"approve","comments":[]}' };
    yield { type: "completed" };
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let dir: string;
let root: string;
let svc: SidecarService;
let n = 0;
const call = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const { response } = await svc.handle({ id: ++n, method, ...(params ? { params } : {}) });
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-goal-"));
  root = join(dir, "project");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, "README.md"), "hi\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  svc = new SidecarService(
    {
      dbPath: join(dir, "s.db"),
      extraAdapters: [new Quiet("impl"), new Quiet("rev")],
      worktreesDir: join(dir, "wt"),
      schedulerIntervalMs: 20,
      secrets: { claude: { ANTHROPIC_API_KEY: SECRET }, codex: {} },
    },
    createLogger({ name: "t", destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
  );
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("user free text never carries a loaded secret back out", () => {
  it("startPeerReview: the goal is masked in context items, task logs and tasks list", async () => {
    const { projectId } = await call<{ projectId: string }>("projects.create", {
      name: "demo",
      rootPath: root,
    });
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    await call("workflows.startPeerReview", {
      workflowId,
      implementerAgent: "impl",
      reviewerAgent: "rev",
      goal: `use the key ${SECRET} to deploy`,
    });
    let tasks: { id: string }[] = [];
    for (let i = 0; i < 100; i++) {
      tasks = (await call<{ tasks: { id: string }[] }>("tasks.list", { workflowId })).tasks;
      if (tasks.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const dumped = [
      JSON.stringify(await call("context.list", { workflowId })),
      ...(await Promise.all(
        tasks.map(async (t) =>
          JSON.stringify(await call("logs.query", { taskId: t.id, afterSequence: 0, limit: 100 })),
        ),
      )),
    ].join("\n");
    expect(dumped).not.toContain(SECRET);
    expect(dumped).toContain("to deploy"); // the rest of the goal is kept
  });
});
