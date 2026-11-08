// Dev-only stand-in for the Rust bridge so the UI can be exercised in a plain browser
// (`pnpm --filter @agent-studio/desktop dev`). Not bundled into production builds.
import type { AgentMessage, SidecarEvent, TaskState } from "@agent-studio/contracts";

const listeners = new Set<(e: SidecarEvent) => void>();
const emit = (e: SidecarEvent) => listeners.forEach((l) => l(e));
export function onPreviewEvent(h: (e: SidecarEvent) => void): () => void {
  listeners.add(h);
  return () => void listeners.delete(h);
}

const projects: { id: string; name: string; rootPath: string }[] = [];
const tasks = new Map<string, { state: TaskState; messages: AgentMessage[]; timer?: number }>();
let n = 0;
const id = (p: string) => `${p}_${++n}`;

function run(taskId: string, prompt: string) {
  const t = tasks.get(taskId)!;
  const say = (type: AgentMessage["type"], payload: unknown) => {
    const message = {
      id: id("msg"),
      schemaVersion: 1,
      workflowId: "w",
      taskId,
      correlationId: "c",
      fromAgent: "stub",
      toAgent: "orchestrator",
      type,
      payload,
      createdAt: new Date().toISOString(),
      sequence: t.messages.length,
    } as AgentMessage;
    t.messages.push(message);
    emit({ event: "task.message", taskId, sequence: message.sequence, message });
  };
  const steps: [AgentMessage["type"], unknown][] = [
    ["task.accepted", { prompt }],
    ["task.progress", { type: "text", content: `preview: received "${prompt}"` }],
    ["task.progress", { type: "tool_call", name: "preview.echo", args: { ok: true } }],
    ["task.progress", { type: "tool_result", result: { ok: true } }],
    ["task.progress", { type: "text", content: "preview: done" }],
    ["task.completed", { type: "completed" }],
  ];
  t.state = "running";
  emit({ event: "task.state", taskId, state: "running" });
  let i = 0;
  t.timer = window.setInterval(() => {
    const step = steps[i++];
    if (step) say(...step);
    if (i >= steps.length) {
      window.clearInterval(t.timer);
      t.state = "completed";
      emit({ event: "task.state", taskId, state: "completed" });
    }
  }, 600);
}

export async function previewCall(method: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, string | number>;
  switch (method) {
    case "projects.list":
      return { projects };
    case "projects.create":
      projects.push({ id: id("proj"), name: String(p.name), rootPath: String(p.rootPath) });
      return { projectId: projects.at(-1)!.id };
    case "agents.list":
      return {
        adapters: [
          { id: "claude", available: false, capabilities: ["streaming", "structured_output"] },
        ],
        cli: [],
      };
    case "agents.detect":
      return { results: [{ provider: "claude", status: "not_installed" }] };
    case "agents.scan":
      return {
        clis: [
          {
            id: "claude",
            displayName: "Claude Code",
            supported: true,
            usable: false,
            status: "not_installed",
            capabilities: {},
          },
        ],
      };
    case "agents.getSettings":
      return { settings: null };
    case "agents.probe":
    case "agents.setSettings":
      return { ok: false, reason: "Agent settings need the desktop app" };
    case "workflows.create":
      return { workflowId: id("wf") };
    case "workflows.start": {
      const taskId = id("task");
      tasks.set(taskId, { state: "queued", messages: [] });
      run(taskId, String(p.prompt));
      return { taskId };
    }
    case "tasks.cancel": {
      const taskId = String(p.taskId);
      const t = tasks.get(taskId);
      if (!t) throw new Error("Unknown task");
      if (t.state !== "running") return { requested: false, state: t.state };
      window.clearInterval(t.timer);
      t.state = "cancelled";
      emit({ event: "task.state", taskId, state: "cancelled", reason: "cancelled by user" });
      return { requested: true, state: "cancelled" };
    }
    case "queryTask":
      return { state: tasks.get(String(p.taskId))?.state ?? null };
    case "logs.query": {
      const t = tasks.get(String(p.taskId));
      if (!t) throw new Error("Unknown task");
      const messages = t.messages
        .filter((m) => m.sequence > Number(p.afterSequence))
        .slice(0, Number(p.limit ?? 200));
      return { messages, nextAfterSequence: messages.at(-1)?.sequence ?? p.afterSequence };
    }
    case "workflows.startPeerReview":
      return { workflowId: String(p.workflowId), state: "running" }; // preview has no real workflow engine
    case "tasks.list":
      return { workflowState: "pending", tasks: [] };
    case "tasks.history":
      return { tasks: [] };
    case "tasks.resolveReconciliation":
      return { state: String(p.decision) === "requeue" ? "queued" : String(p.decision) };
    case "resources.get":
    case "resources.set": {
      const d = {
        concurrency: 2,
        thresholds: {
          cpu: { reduceAt: 85, pauseAt: 95 },
          memory: { reduceAt: 80, pauseAt: 90 },
          releaseMarginPercent: 5,
        },
      };
      return {
        settings: method === "resources.set" ? p.settings : d,
        defaults: d,
        status: {
          concurrency: 2,
          effectiveConcurrency: 2,
          running: 0,
          queued: 0,
          monitor: {
            level: "normal",
            reasons: [],
            measured: true,
            cpuPercent: 12,
            memoryPercent: 48,
          },
        },
      };
    }
    case "diagnostics.export":
      return {
        dir: "(preview) diagnostics-20260101T000000Z",
        manifestPath: "(preview) manifest.json",
        files: [
          { path: "versions.json", bytes: 120 },
          { path: "config.json", bytes: 340 },
        ],
        verified: true,
        problems: [],
        limits: "preview stub: nothing was written",
      };
    case "recovery.inspect":
      return {
        taskId: String(p.taskId),
        state: "needs_reconciliation",
        attempt: 0,
        classification: "side_effects_unverified",
        evidence: {
          messageCount: 4,
          producedOutput: true,
          toolCalls: 1,
          unfinishedToolCalls: 1,
          hasStoredPrompt: true,
          hasWorktree: false,
          worktreeChanged: null,
          flaggedByPolicy: false,
        },
        actions: {
          resume: { allowed: true, confirmation: true },
          retry: { allowed: true, confirmation: true },
          abandon: { allowed: true, confirmation: false },
        },
      };
    case "recovery.resolve":
      return {
        state: { resume: "completed", retry: "queued", abandon: "cancelled" }[String(p.action)],
      };
    case "logs.search":
      return { hits: [] };
    case "roles.list":
      return { roles: [] };
    case "context.list":
      return { items: [] };
    case "approvals.list":
      return { approvals: [] };
    case "approvals.resolve":
      return { resolved: true };
    case "artifacts.diff":
      return { patch: "", truncated: false };
    case "artifacts.list":
      return { artifacts: [] };
    case "worktrees.list":
      return { worktrees: [] };
    default:
      throw new Error(`preview: unsupported ${method}`);
  }
}
