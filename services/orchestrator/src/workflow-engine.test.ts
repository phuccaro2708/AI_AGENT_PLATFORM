import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { AdapterRegistry, type AgentAdapter, type AgentTask } from "@agent-studio/agent-core";
import type { AgentCapability, AgentEvent } from "@agent-studio/contracts";
import { GitWorktrees } from "@agent-studio/git-worktrees";
import { createLogger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { Orchestrator, Scheduler, TaskRunner, WorkflowEngine, type RoleDef } from "./index.js";

type Script = (task: AgentTask) => string | Promise<string> | AgentEvent[];

/** Test double: runs a script in the task's cwd (may write files) and emits its text. */
class ScriptedAdapter implements AgentAdapter {
  readonly prompts: string[] = [];
  readonly cwds: string[] = [];
  constructor(
    readonly id: string,
    private script: Script,
  ) {}
  async detect() {
    return true;
  }
  async capabilities(): Promise<AgentCapability[]> {
    return ["streaming"];
  }
  async cancel() {}
  async *execute(task: AgentTask): AsyncIterable<AgentEvent> {
    this.prompts.push(task.prompt);
    this.cwds.push(task.cwd);
    const out = await this.script(task);
    if (Array.isArray(out)) yield* out;
    else yield { type: "text", content: out };
    yield { type: "completed" };
  }
}

const implementerRole: RoleDef = {
  name: "implementer",
  instructions: "Implement the goal.",
  access: "write",
  allowedAgents: ["claude"],
  sees: ["goal"],
};
const reviewerRole: RoleDef = {
  name: "reviewer",
  instructions: "Review the change. End with VERDICT: APPROVE or VERDICT: CHANGES_REQUESTED.",
  access: "read",
  allowedAgents: "any",
  sees: ["goal", "artifact", "report"],
};
const workerRole: RoleDef = {
  name: "worker",
  instructions: "Do your part.",
  access: "write",
  allowedAgents: "any",
  sees: ["goal"],
};

let dir: string;
let db: StudioDb;
let repo: Repo;
let runner: TaskRunner;
let engine: WorkflowEngine;
let wf: string;
let gitRoot: string;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

function build(claudeScript: Script, codexScript: Script) {
  claude = new ScriptedAdapter("claude", claudeScript);
  codex = new ScriptedAdapter("codex", codexScript);
  const registry = new AdapterRegistry();
  registry.register(claude);
  registry.register(codex);
  const log = createLogger({
    name: "t",
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const worktreesFor = (root: string) => new GitWorktrees({ repoRoot: root });
  runner = new TaskRunner({
    orchestrator: new Orchestrator(registry, repo, log),
    repo,
    scheduler: new Scheduler(repo),
    registry,
    log,
    worktreesFor,
  });
  engine = new WorkflowEngine({ runner, repo, worktreesFor, pollMs: 5 });
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-studio-engine-")));
  db = openDatabase(join(dir, "e.db"));
  runMigrations(db);
  repo = new Repo(db);
  gitRoot = join(dir, "proj");
  mkdirSync(gitRoot);
  execFileSync("git", ["init", "-q", "-b", "main", gitRoot]);
  writeFileSync(join(gitRoot, "a.txt"), "base\n");
  git(gitRoot, "add", "a.txt");
  git(gitRoot, "commit", "-m", "base");
  wf = repo.createWorkflow(repo.createProject("p", gitRoot));
});
afterEach(async () => {
  await runner.settle();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("WorkflowEngine.runPeerReview (implement → review)", () => {
  it("hands the implementer's committed work to the reviewer with no manual copying", async () => {
    let reviewerSaw = "";
    build(
      (t) => {
        writeFileSync(join(t.cwd, "feature.txt"), "feature\n");
        return "implemented feature.txt";
      },
      (t) => {
        reviewerSaw = existsSync(join(t.cwd, "feature.txt"))
          ? readFileSync(join(t.cwd, "feature.txt"), "utf8").trim()
          : "MISSING";
        return "Looks right.\nVERDICT: APPROVE";
      },
    );
    const r = await engine.runPeerReview({
      workflowId: wf,
      goal: "add feature.txt",
      implementer: { role: implementerRole, agentId: "claude" },
      reviewer: { role: reviewerRole, agentId: "codex" },
    });
    expect(r.outcome).toBe("approved");
    expect(reviewerSaw).toBe("feature");
    expect(repo.getWorkflowState(wf)).toBe("completed");
    // reviewer prompt: role + goal + verified diffstat + agent-reported summary, clearly labelled
    const prompt = codex.prompts[0]!;
    expect(prompt).toContain("Review the change");
    expect(prompt).toContain("feature.txt");
    expect(prompt).toMatch(/agent-reported/i);
    expect(prompt).toMatch(/verified/i);
    // the checkpoint lives on the implementer's branch; main is untouched
    expect(git(gitRoot, "log", "main", "--oneline")).not.toContain("checkpoint");
    expect(git(gitRoot, "show", `${r.implement.branch}:feature.txt`)).toBe("feature");
    // handoff is recorded on the task streams
    expect(repo.listMessages(r.implement.taskId).map((m) => m.type)).toContain("review.request");
    expect(repo.listMessages(r.review!.taskId).map((m) => m.type)).toContain("review.result");
  });

  it("reports changes_requested without failing the workflow", async () => {
    build(
      (t) => {
        writeFileSync(join(t.cwd, "x.txt"), "x");
        return "done";
      },
      () => "Needs tests.\nVERDICT: CHANGES_REQUESTED",
    );
    const r = await engine.runPeerReview({
      workflowId: wf,
      goal: "g",
      implementer: { role: implementerRole, agentId: "claude" },
      reviewer: { role: reviewerRole, agentId: "codex" },
    });
    expect(r.outcome).toBe("changes_requested");
    expect(repo.getWorkflowState(wf)).toBe("completed");
  });

  it("pauses for a human when the reviewer gives no parseable verdict", async () => {
    build(
      (t) => {
        writeFileSync(join(t.cwd, "x.txt"), "x");
        return "done";
      },
      () => "I think it is fine.",
    );
    const r = await engine.runPeerReview({
      workflowId: wf,
      goal: "g",
      implementer: { role: implementerRole, agentId: "claude" },
      reviewer: { role: reviewerRole, agentId: "codex" },
    });
    expect(r.outcome).toBe("verdict_unknown");
    expect(repo.getWorkflowState(wf)).toBe("paused");
  });

  it("skips review when the implementer changed nothing", async () => {
    build(
      () => "I looked but changed nothing",
      () => "should not run",
    );
    const r = await engine.runPeerReview({
      workflowId: wf,
      goal: "g",
      implementer: { role: implementerRole, agentId: "claude" },
      reviewer: { role: reviewerRole, agentId: "codex" },
    });
    expect(r.outcome).toBe("no_changes");
    expect(codex.prompts).toEqual([]);
    expect(repo.getWorkflowState(wf)).toBe("completed");
  });

  it("fails the workflow, and does not review, when the implementer fails", async () => {
    build(
      () => [{ type: "error", message: "boom" }],
      () => "should not run",
    );
    const r = await engine.runPeerReview({
      workflowId: wf,
      goal: "g",
      implementer: { role: implementerRole, agentId: "claude" },
      reviewer: { role: reviewerRole, agentId: "codex" },
    });
    expect(r.outcome).toBe("implement_failed");
    expect(codex.prompts).toEqual([]);
    expect(repo.getWorkflowState(wf)).toBe("failed");
  });

  it("refuses a role assignment the role does not allow, before running anything", async () => {
    build(
      () => "x",
      () => "y",
    );
    await expect(
      engine.runPeerReview({
        workflowId: wf,
        goal: "g",
        implementer: { role: implementerRole, agentId: "codex" }, // implementer allows only claude
        reviewer: { role: reviewerRole, agentId: "claude" },
      }),
    ).rejects.toThrow(/not allowed/i);
    expect(codex.prompts).toEqual([]);
  });
});

describe("WorkflowEngine shared context board", () => {
  const approve = () => "fine\nVERDICT: APPROVE";
  const peer = (implementer: RoleDef = implementerRole) =>
    engine.runPeerReview({
      workflowId: wf,
      goal: "THE-GOAL",
      implementer: { role: implementer, agentId: "claude" },
      reviewer: { role: reviewerRole, agentId: "codex" },
    });
  const writeF = (t: AgentTask) => writeFileSync(join(t.cwd, "f.txt"), "f\n");

  it("gives the reviewer the final report and files, never the implementer's raw log", async () => {
    build((t) => {
      writeF(t);
      return [
        { type: "text", content: "INTERMEDIATE-THOUGHT" },
        { type: "tool_call", name: "RAW-TOOL", args: {} },
        { type: "tool_result", result: "RAW-RESULT" },
        { type: "text", content: "FINAL-REPORT" },
      ] as AgentEvent[];
    }, approve);
    await peer();
    const prompt = codex.prompts[0]!;
    expect(prompt).toContain("FINAL-REPORT");
    expect(prompt).toContain("f.txt");
    for (const raw of ["INTERMEDIATE-THOUGHT", "RAW-TOOL", "RAW-RESULT"]) {
      expect(prompt).not.toContain(raw);
    }
    expect(prompt).toMatch(/not instructions/i);
  });

  it("shows a plan only to roles whose sees includes plan", async () => {
    build((t) => {
      writeF(t);
      return "done";
    }, approve);
    engine.board.add(wf, { kind: "plan", source: "agent-reported", content: "SECRET-PLAN" });
    await peer(); // implementer sees only the goal; the reviewer has no plan access
    expect(claude.prompts[0]).not.toContain("SECRET-PLAN");
    expect(codex.prompts[0]).not.toContain("SECRET-PLAN");
  });

  it("does show the plan to a role that is allowed to see it", async () => {
    build((t) => {
      writeF(t);
      return "done";
    }, approve);
    engine.board.add(wf, { kind: "plan", source: "agent-reported", content: "SECRET-PLAN" });
    await peer({ ...implementerRole, sees: ["goal", "plan"] });
    expect(claude.prompts[0]).toContain("SECRET-PLAN");
    expect(codex.prompts[0]).not.toContain("SECRET-PLAN");
  });

  it("records the goal, verified artifacts (real sha256, deletions) and an agent-reported report", async () => {
    build((t) => {
      writeFileSync(join(t.cwd, "feature.txt"), "feature\n");
      rmSync(join(t.cwd, "a.txt"));
      return "my report";
    }, approve);
    await peer();
    const entries = repo.listContextEntries(wf);
    const of = (k: string) => entries.filter((e) => e.kind === k);
    expect(of("goal")).toMatchObject([{ source: "user", content: "THE-GOAL" }]);
    expect(of("report")).toMatchObject([{ source: "agent-reported", content: "my report" }]);
    const art = Object.fromEntries(of("artifact").map((e) => [e.path, e]));
    expect(art["feature.txt"]).toMatchObject({
      source: "verified",
      sha256: createHash("sha256").update("feature\n").digest("hex"),
    });
    expect(art["a.txt"]).toMatchObject({ source: "verified", sha256: null });
  });
});

describe("WorkflowEngine.runParallelWorkers", () => {
  it("runs workers in separate worktrees without overwriting each other and reports no conflict", async () => {
    build(
      (t) => {
        writeFileSync(join(t.cwd, "from-claude.txt"), "c");
        return "ok";
      },
      (t) => {
        writeFileSync(join(t.cwd, "from-codex.txt"), "x");
        return "ok";
      },
    );
    const r = await engine.runParallelWorkers({
      workflowId: wf,
      role: workerRole,
      workers: [
        { agentId: "claude", prompt: "p1" },
        { agentId: "codex", prompt: "p2" },
      ],
    });
    expect(r.workers.every((w) => w.state === "completed" && w.committed)).toBe(true);
    expect(new Set(r.workers.map((w) => w.branch)).size).toBe(2);
    expect(r.conflicts).toEqual([]);
    expect(repo.getWorkflowState(wf)).toBe("completed");
    expect(existsSync(join(gitRoot, "from-claude.txt"))).toBe(false); // project root untouched
  });

  it("detects workers whose changes would conflict", async () => {
    build(
      (t) => {
        writeFileSync(join(t.cwd, "a.txt"), "claude version\n");
        return "ok";
      },
      (t) => {
        writeFileSync(join(t.cwd, "a.txt"), "codex version\n");
        return "ok";
      },
    );
    const r = await engine.runParallelWorkers({
      workflowId: wf,
      role: workerRole,
      workers: [
        { agentId: "claude", prompt: "p1" },
        { agentId: "codex", prompt: "p2" },
      ],
    });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.files).toEqual(["a.txt"]);
  });

  it("marks the workflow failed when any worker fails but still reports the others", async () => {
    build(
      () => [{ type: "error", message: "boom" }],
      (t) => {
        writeFileSync(join(t.cwd, "ok.txt"), "x");
        return "ok";
      },
    );
    const r = await engine.runParallelWorkers({
      workflowId: wf,
      role: workerRole,
      workers: [
        { agentId: "claude", prompt: "p1" },
        { agentId: "codex", prompt: "p2" },
      ],
    });
    expect(r.workers.map((w) => w.state).sort()).toEqual(["completed", "failed"]);
    expect(repo.getWorkflowState(wf)).toBe("failed");
  });
});

describe("WorkflowEngine.runSupervised", () => {
  const supervisorRole: RoleDef = {
    name: "supervisor",
    instructions: "Plan only.",
    access: "read",
    allowedAgents: ["claude"],
    sees: ["goal"],
  };
  const subRole: RoleDef = { ...workerRole, sees: ["goal", "plan", "artifact", "report"] };
  const fence = (j: unknown) => `Plan:\n\`\`\`json\n${JSON.stringify(j)}\n\`\`\``;
  const sub = (id: string, dependsOn: string[] = []) => ({
    id,
    title: "T" + id,
    prompt: "do " + id,
    dependsOn,
  });
  const idOf = (t: AgentTask) => subtaskOf(t.prompt);
  const subtaskOf = (prompt: string) => /Your subtask \[(\w+)\]/.exec(prompt)![1]!;
  const run = () =>
    engine.runSupervised({
      workflowId: wf,
      goal: "BIG-GOAL",
      supervisor: { role: supervisorRole, agentId: "claude" },
      workerRole: subRole,
      workerAgents: ["codex"],
    });

  it("runs the plan layer by layer; a single dependency starts from that branch and reports flow through the board", async () => {
    build(
      () => fence({ subtasks: [sub("a"), sub("b"), sub("c", ["a"])] }),
      (t) => {
        const id = idOf(t);
        writeFileSync(join(t.cwd, id + ".txt"), id);
        return "report-" + id;
      },
    );
    const r = await run();
    expect(r.outcome).toBe("completed");
    expect(r.steps.map((x) => x.subtaskId).sort()).toEqual(["a", "b", "c"]);
    const order = codex.prompts.map(subtaskOf);
    expect(order.indexOf("c")).toBe(2); // after both layer-0 subtasks
    const cPrompt = codex.prompts[2]!;
    expect(cPrompt).toContain("report-a"); // dependency's report arrives via the board
    expect(cPrompt).toContain("a.txt");
    expect(codex.cwds[2]!.length).toBeGreaterThan(0);
    expect(existsSync(join(codex.cwds[2]!, "a.txt"))).toBe(true); // started from a's branch
    expect(repo.getWorkflowState(wf)).toBe("completed");
    expect(repo.listContextEntries(wf).filter((e) => e.kind === "plan")).toHaveLength(1);
    expect(claude.prompts[0]).toContain("BIG-GOAL");
  });

  it("pauses the workflow on an invalid plan and starts no worker", async () => {
    build(
      () => "I could not decide.",
      () => "never",
    );
    const r = await run();
    expect(r.outcome).toBe("plan_invalid");
    expect(r.error).toMatch(/no JSON/);
    expect(codex.prompts).toEqual([]);
    expect(repo.getWorkflowState(wf)).toBe("paused");
  });

  it("skips dependents of a failed subtask and fails the workflow", async () => {
    build(
      () => fence({ subtasks: [sub("a"), sub("b"), sub("c", ["a"])] }),
      (t) => {
        const id = idOf(t);
        if (id === "a") return [{ type: "error", message: "boom" }];
        writeFileSync(join(t.cwd, id + ".txt"), id);
        return "ok";
      },
    );
    const r = await run();
    expect(r.outcome).toBe("subtask_failed");
    expect(r.skipped).toEqual(["c"]);
    expect(r.steps.find((x) => x.subtaskId === "b")?.state).toBe("completed");
    expect(repo.getWorkflowState(wf)).toBe("failed");
  });

  it("fails without planning when the supervisor itself fails", async () => {
    build(
      () => [{ type: "error", message: "boom" }],
      () => "never",
    );
    const r = await run();
    expect(r.outcome).toBe("supervisor_failed");
    expect(codex.prompts).toEqual([]);
  });
});
