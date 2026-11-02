import { SidecarRequest, type SidecarEvent, type SidecarResponse } from "@agent-studio/contracts";
import { AdapterRegistry, StubAdapter, type AgentAdapter } from "@agent-studio/agent-core";
import { ClaudeAdapter } from "@agent-studio/adapter-claude";
import { probeClaude, probeCodex, type ProbeResult } from "@agent-studio/cli-probe";
import { createLogger, type Logger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { Orchestrator } from "./orchestrator.js";

export interface SidecarOptions {
  dbPath: string;
  nativeBinding?: string;
  migrationsFolder?: string;
  /** Test seam: adapters to register in addition to the stub. */
  extraAdapters?: AgentAdapter[];
  /** Receives server-pushed events (the transport decides how to deliver / drop them). */
  onEvent?: (event: SidecarEvent) => void;
  /** Test seam: replaces the real CLI probes. */
  probes?: Partial<Record<"claude" | "codex", () => Promise<ProbeResult>>>;
}

const ok = (id: number, result: unknown) => ({
  response: { id, result } as SidecarResponse,
  shutdown: false,
});
const fail = (id: number, message: string) => ({
  response: { id, error: { message } } as SidecarResponse,
  shutdown: false,
});

/** Transport-independent request handler (unit-testable). */
export class SidecarService {
  readonly db: StudioDb;
  private readonly repo: Repo;
  private readonly registry = new AdapterRegistry();
  private readonly orchestrator: Orchestrator;
  private readonly workflowId: string;
  private readonly recoveredTasks: number;
  private readonly probes: Record<"claude" | "codex", () => Promise<ProbeResult>>;
  /** Tasks currently executing in this process. */
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(
    private readonly opts: SidecarOptions,
    private readonly log: Logger,
  ) {
    this.probes = {
      claude: () => probeClaude(),
      codex: () => probeCodex(),
      ...opts.probes,
    };
    this.db = openDatabase(
      opts.dbPath,
      opts.nativeBinding ? { nativeBinding: opts.nativeBinding } : {},
    );
    if (opts.migrationsFolder) runMigrations(this.db, opts.migrationsFolder);
    else runMigrations(this.db);
    this.repo = new Repo(this.db);
    const recovered = this.repo.recoverInterruptedTasks();
    if (recovered.length > 0) {
      log.warn(
        { taskIds: recovered },
        "tasks interrupted by a previous exit -> needs_reconciliation",
      );
    }
    this.recoveredTasks = recovered.length;
    this.registry.register(new StubAdapter());
    this.registry.register(new ClaudeAdapter());
    for (const a of opts.extraAdapters ?? []) this.registry.register(a);
    this.orchestrator = new Orchestrator(this.registry, this.repo, log, {
      onMessage: (message) =>
        opts.onEvent?.({
          event: "task.message",
          taskId: message.taskId,
          sequence: message.sequence,
          message,
        }),
      onState: (taskId, state, reason) =>
        opts.onEvent?.({ event: "task.state", taskId, state, ...(reason ? { reason } : {}) }),
    });
    this.workflowId = this.repo.createWorkflow(
      this.repo.createProject(`spike-${process.pid}`, `spike://${process.pid}-${Date.now()}`),
    );
  }

  async handle(raw: unknown): Promise<{ response: SidecarResponse; shutdown: boolean }> {
    const parsed = SidecarRequest.safeParse(raw);
    if (!parsed.success) {
      const id =
        typeof (raw as { id?: unknown })?.id === "number" ? (raw as { id: number }).id : null;
      return { response: { id, error: { message: "invalid request" } }, shutdown: false };
    }
    const req = parsed.data;
    try {
      switch (req.method) {
        case "health": {
          const v = this.db.$client.prepare("select sqlite_version() as v").pluck().get();
          const journal = this.db.$client.pragma("journal_mode", { simple: true });
          return {
            response: {
              id: req.id,
              result: {
                pid: process.pid,
                node: process.version,
                platform: process.platform,
                sqlite: v,
                journalMode: journal,
                dbPath: this.opts.dbPath,
                recoveredTasks: this.recoveredTasks,
              },
            },
            shutdown: false,
          };
        }
        case "runStub": {
          const r = await this.orchestrator.runTask({
            workflowId: this.workflowId,
            agentId: "stub",
            prompt: req.params.prompt,
            cwd: process.cwd(),
          });
          return {
            response: {
              id: req.id,
              result: {
                taskId: r.taskId,
                finalState: r.finalState,
                eventCount: r.events.length,
                messageCount: this.repo.listMessages(r.taskId).length,
              },
            },
            shutdown: false,
          };
        }
        case "queryTask": {
          const state = this.repo.getTaskState(req.params.taskId) ?? null;
          return {
            response: {
              id: req.id,
              result: {
                state,
                messageCount: state ? this.repo.listMessages(req.params.taskId).length : 0,
              },
            },
            shutdown: false,
          };
        }
        case "agents.list": {
          const adapters = await Promise.all(
            this.registry.list().map(async (a) => ({
              id: a.id,
              available: await a.detect().catch(() => false),
              capabilities: await a.capabilities().catch(() => []),
            })),
          );
          return ok(req.id, { adapters, cli: this.repo.listAgentProbes() });
        }
        case "agents.detect": {
          const wanted = req.params.providers ?? ["claude", "codex"];
          const results = [];
          for (const p of wanted) {
            const r = await this.probes[p]();
            this.repo.saveAgentProbe({
              provider: r.provider,
              status: r.status,
              ...(r.path !== undefined ? { path: r.path } : {}),
              ...(r.version !== undefined ? { version: r.version } : {}),
              capabilities: r.capabilities,
              ...(r.error !== undefined ? { error: r.error } : {}),
              probedAt: r.probedAt,
            });
            results.push(r);
          }
          return ok(req.id, { results });
        }
        case "agents.capabilities":
          return ok(req.id, { probe: this.repo.getAgentProbe(req.params.provider) ?? null });
        case "projects.create":
          return ok(req.id, {
            projectId: this.repo.createProject(req.params.name, req.params.rootPath),
          });
        case "projects.list":
          return ok(req.id, { projects: this.repo.listProjects() });
        case "workflows.create": {
          if (!this.repo.listProjects().some((p) => p.id === req.params.projectId)) {
            return fail(req.id, `Unknown project: ${req.params.projectId}`);
          }
          return ok(req.id, { workflowId: this.repo.createWorkflow(req.params.projectId) });
        }
        case "workflows.start": {
          const root = this.repo.getWorkflowRoot(req.params.workflowId);
          if (!root) return fail(req.id, `Unknown workflow: ${req.params.workflowId}`);
          if (!this.registry.get(req.params.agentId)) {
            return fail(req.id, `Unknown agent: ${req.params.agentId}`);
          }
          // Runs in the background so `tasks.cancel` and other requests are served meanwhile.
          const ac = new AbortController();
          let taskId = "";
          const run = this.orchestrator
            .runTask({
              workflowId: req.params.workflowId,
              agentId: req.params.agentId,
              prompt: req.params.prompt,
              cwd: root.rootPath,
              signal: ac.signal,
              onCreated: (id) => {
                taskId = id;
                this.active.set(id, { abort: ac, done: Promise.resolve() });
              },
            })
            .catch((err: unknown) => this.log.error({ err: String(err) }, "background task failed"))
            .finally(() => this.active.delete(taskId));
          const entry = this.active.get(taskId);
          if (entry) entry.done = run.then(() => undefined);
          return ok(req.id, { taskId });
        }
        case "tasks.cancel": {
          const state = this.repo.getTaskState(req.params.taskId);
          if (state === undefined) return fail(req.id, `Unknown task: ${req.params.taskId}`);
          const live = this.active.get(req.params.taskId);
          if (live) {
            live.abort.abort(); // the adapter reports "cancelled"; the orchestrator settles the state
            return ok(req.id, { requested: true, state });
          }
          if (state === "queued") {
            this.repo.setTaskState(req.params.taskId, "cancelled", { reason: "cancelled by user" });
            this.opts.onEvent?.({
              event: "task.state",
              taskId: req.params.taskId,
              state: "cancelled",
              reason: "cancelled by user",
            });
            return ok(req.id, { requested: true, state: "cancelled" });
          }
          return ok(req.id, { requested: false, state });
        }
        case "logs.query": {
          const { taskId, afterSequence, limit } = req.params;
          if (this.repo.getTaskState(taskId) === undefined) {
            return fail(req.id, `Unknown task: ${taskId}`);
          }
          const messages = this.repo.listMessagesAfter(taskId, afterSequence, limit);
          return ok(req.id, {
            messages,
            nextAfterSequence: messages.at(-1)?.sequence ?? afterSequence,
          });
        }
        case "shutdown":
          return { response: { id: req.id, result: { ok: true } }, shutdown: true };
      }
    } catch (err) {
      return { response: { id: req.id, error: { message: String(err) } }, shutdown: false };
    }
  }

  /** Resolves when every background task has settled (tests, graceful shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.active.values()].map((a) => a.done));
  }

  close(): void {
    for (const a of this.active.values()) a.abort.abort();
    if (this.db.$client.open) this.db.$client.close();
  }
}

export { createLogger };
