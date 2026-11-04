import {
  canTransitionWorkflow,
  SidecarRequest,
  type SidecarEvent,
  type SidecarResponse,
} from "@agent-studio/contracts";
import { AdapterRegistry, StubAdapter, type AgentAdapter } from "@agent-studio/agent-core";
import {
  createSecretRedactor,
  noSecrets,
  type ProviderSecrets,
  type SecretRedactor,
} from "./secrets.js";
import { checkAgentSettings, type AgentLaunchSettings } from "./agent-settings.js";
import { ClaudeAdapter } from "@agent-studio/adapter-claude";
import { CodexAdapter } from "@agent-studio/adapter-codex";
import {
  probeClaude,
  probeCodex,
  scanClis,
  CLI_CANDIDATES,
  type ProbeOptions,
  type ProbeResult,
} from "@agent-studio/cli-probe";
import { createLogger, type Logger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { dirname, join } from "node:path";
import { ApprovalService } from "./approvals.js";
import { ArtifactRegistry } from "./artifacts.js";
import { ContextBoard } from "./context-board.js";
import { Orchestrator } from "./orchestrator.js";
import { Scheduler } from "./scheduler.js";
import { checkProjectRoot, duplicateOf } from "./project-policy.js";
import { PeerReviewEngine } from "./workflow-engine.js";
import { ProjectWorkspaces } from "./workspaces.js";

export interface SidecarOptions {
  dbPath: string;
  nativeBinding?: string;
  migrationsFolder?: string;
  /** Test seam: adapters to register in addition to the stub. */
  extraAdapters?: AgentAdapter[];
  /** Receives server-pushed events (the transport decides how to deliver / drop them). */
  onEvent?: (event: SidecarEvent) => void;
  /** Test seam: replaces the real CLI probes. */
  probes?: Partial<Record<"claude" | "codex", (o?: ProbeOptions) => Promise<ProbeResult>>>;
  /** Test seam: replaces the scan of CLIs that have no adapter. */
  scan?: typeof scanClis;
  /** Where agent worktrees are created. Default: `worktrees` next to the database (keep it short on Windows). */
  worktreesDir?: string;
  /** Per-provider secrets handed in by the native side. Never stored, logged or returned. */
  secrets?: ProviderSecrets;
  /** How often the scheduler looks for ready tasks once a workflow has started. Default 500. */
  schedulerIntervalMs?: number;
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
/** ~120 characters of stored payload around the first (case-insensitive) match. */
function snippetAround(payloadJson: string, query: string): string {
  const at = payloadJson.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, (at < 0 ? 0 : at) - 50);
  const end = Math.min(payloadJson.length, start + 120);
  return `${start > 0 ? "…" : ""}${payloadJson.slice(start, end)}${end < payloadJson.length ? "…" : ""}`;
}

/** What the adapters rely on; settings are accepted only for a program that shows all of them. */
const REQUIRED_CAPABILITIES = {
  claude: ["print", "outputStreamJson"],
  codex: ["execSubcommand", "execJson"],
} as const;

export class SidecarService {
  readonly db: StudioDb;
  private readonly repo: Repo;
  private readonly registry = new AdapterRegistry();
  private readonly orchestrator: Orchestrator;
  private readonly scheduler: Scheduler;
  private readonly engine: PeerReviewEngine;
  private readonly approvals: ApprovalService;
  private readonly artifacts: ArtifactRegistry;
  /** Phase 0 spike workflow for `runStub`; created on first use so a normal start adds no project. */
  private spikeWorkflowId: string | undefined;
  private readonly recoveredTasks: number;
  private readonly secrets: ProviderSecrets;
  private readonly redactor: SecretRedactor;
  private readonly probes: Record<"claude" | "codex", (o?: ProbeOptions) => Promise<ProbeResult>>;
  /** Tasks currently executing in this process. */
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();

  private get rootPolicy() {
    return {
      dbPath: this.opts.dbPath,
      worktreesDir: this.opts.worktreesDir ?? join(dirname(this.opts.dbPath), "worktrees"),
    };
  }

  /**
   * Re-checks a stored root before work starts: the folder may have been moved or deleted since
   * the project was created, and projects from before the policy existed were never checked.
   */
  private rootProblem(rootPath: string): string | null {
    if (rootPath.startsWith("spike://")) return null; // Phase 0 spike project, no real folder
    const r = checkProjectRoot(rootPath, this.rootPolicy);
    return r.ok ? null : `Project folder unusable: ${r.reason}`;
  }

  /**
   * The CLI adapter for a provider, launched as the stored (already probed) settings say, or with
   * defaults. The child gets the sidecar's environment plus the configured variables.
   */
  private buildCliAdapter(
    provider: "claude" | "codex",
    s?: { command: string; args: string[]; env: Record<string, string> },
  ): AgentAdapter {
    const secret = this.secrets[provider];
    const o =
      s || Object.keys(secret).length > 0
        ? {
            ...(s ? { command: s.command, extraArgs: s.args } : {}),
            env: this.childEnv(provider, s?.env ?? {}),
          }
        : {};
    return provider === "claude" ? new ClaudeAdapter(o) : new CodexAdapter(o);
  }

  /**
   * `agents.scan`: every known candidate. CLIs with an adapter (`this.probes`) go through the same
   * settings-aware probe as `agents.detect` (which owns their stored row); the others are scanned
   * and their probe stored. Only `supported` CLIs may be picked to run tasks.
   */
  private async scanAll() {
    const supported = (id: string) => id in this.probes;
    const scanned = new Map(
      (
        await (this.opts.scan ?? scanClis)({
          candidates: CLI_CANDIDATES.filter((c) => !supported(c.id)),
        })
      ).map((s) => [s.provider, s]),
    );
    const out = [];
    for (const c of CLI_CANDIDATES) {
      let r: ProbeResult & { usable?: boolean };
      if (supported(c.id)) {
        r = await this.probeStored(c.id as "claude" | "codex");
        this.saveProbe(r);
        r.usable = r.status === "ok";
      } else {
        const s = scanned.get(c.id);
        if (!s) continue;
        r = s;
        if (r.path !== undefined) this.saveProbe(r);
      }
      out.push({
        id: c.id,
        displayName: c.displayName,
        supported: supported(c.id),
        usable: r.usable === true,
        status: r.status,
        ...(r.path !== undefined ? { path: r.path } : {}),
        ...(r.version !== undefined ? { version: r.version } : {}),
        capabilities: r.capabilities,
        ...(r.error !== undefined ? { error: r.error } : {}),
        probedAt: r.probedAt,
      });
    }
    return out;
  }

  private saveProbe(r: ProbeResult) {
    this.repo.saveAgentProbe({
      provider: r.provider,
      status: r.status,
      ...(r.path !== undefined ? { path: r.path } : {}),
      ...(r.version !== undefined ? { version: r.version } : {}),
      capabilities: r.capabilities,
      ...(r.error !== undefined ? { error: r.error } : {}),
      probedAt: r.probedAt,
    });
  }

  /** `agents.detect`: probes the CLI the way it will actually be launched. */
  private probeStored(provider: "claude" | "codex") {
    const s = this.repo.getAgentSettings(provider);
    return s ? this.probeWith(provider, s.command, s.env) : this.probes[provider]();
  }

  /**
   * Validates and probes proposed settings without storing anything. A program that merely prints a
   * version and exits 0 is not accepted: the probe must have seen every capability the adapter relies on.
   */
  private async tryAgentSettings(provider: "claude" | "codex", input: AgentLaunchSettings) {
    const checked = checkAgentSettings(input);
    if (!checked.ok) return { ok: false as const, reason: checked.reason };
    const probe = await this.probeWith(provider, checked.resolvedPath, checked.settings.env);
    // The adapter needs these to talk to the CLI at all. Any single flag is not enough: `node`
    // also lists `-p, --print`.
    const looksLikeTheCli = REQUIRED_CAPABILITIES[provider].every((c) => probe.capabilities[c]);
    return { ok: probe.status === "ok" && looksLikeTheCli, probe, checked, looksLikeTheCli };
  }

  /** What an agent of this provider is started with: our environment, its settings, its secrets. */
  private childEnv(provider: "claude" | "codex", env: Record<string, string>) {
    return { ...process.env, ...env, ...this.secrets[provider] };
  }

  private probeWith(provider: "claude" | "codex", executable: string, env: Record<string, string>) {
    return this.probes[provider]({ executable, env: this.childEnv(provider, env) });
  }

  constructor(
    private readonly opts: SidecarOptions,
    private readonly log: Logger,
  ) {
    this.secrets = opts.secrets ?? noSecrets();
    this.redactor = createSecretRedactor(this.secrets);
    this.probes = {
      claude: (o) => probeClaude(o),
      codex: (o) => probeCodex(o),
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
    this.registry.register(this.buildCliAdapter("claude", this.repo.getAgentSettings("claude")));
    this.registry.register(this.buildCliAdapter("codex", this.repo.getAgentSettings("codex")));
    for (const a of opts.extraAdapters ?? []) this.registry.register(a);
    this.orchestrator = new Orchestrator(this.registry, this.repo, log, {
      redactor: this.redactor,
      onMessage: (message) =>
        opts.onEvent?.({
          event: "task.message",
          taskId: message.taskId,
          sequence: message.sequence,
          message,
        }),
      onState: (taskId, state, reason) =>
        opts.onEvent?.({ event: "task.state", taskId, state, ...(reason ? { reason } : {}) }),
      resolveCwd: (ctx) => this.engine.resolveCwd(ctx),
    });
    const workspaces = new ProjectWorkspaces(
      this.repo,
      opts.worktreesDir ?? join(dirname(opts.dbPath), "worktrees"),
    );
    this.engine = new PeerReviewEngine({
      repo: this.repo,
      orchestrator: this.orchestrator,
      board: new ContextBoard(this.repo),
      workspaces,
    });
    this.scheduler = new Scheduler({
      repo: this.repo,
      orchestrator: this.orchestrator,
      onSettled: (id, result) => this.engine.onSettled(id, result),
    });
    // Workflows left `running` by a previous exit need the scheduler again (it starts lazily otherwise).
    if (this.repo.listWorkflowIdsByState("running").length > 0) {
      this.scheduler.start(opts.schedulerIntervalMs);
    }
    void this.engine
      .resumeAll()
      .catch((err) => log.error({ err: this.redactor.text(String(err)) }, "resume failed"));
    this.approvals = new ApprovalService({ repo: this.repo });
    this.artifacts = new ArtifactRegistry(this.repo, workspaces);
  }

  private spikeWorkflow(): string {
    this.spikeWorkflowId ??= this.repo.createWorkflow(
      this.repo.createProject(`spike-${process.pid}`, `spike://${process.pid}-${Date.now()}`),
    );
    return this.spikeWorkflowId;
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
            workflowId: this.spikeWorkflow(),
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
            // The stub is an internal Phase 0 fixture (runStub, selftest); it is not an agent a
            // person can pick, so it is never listed.
            this.registry
              .list()
              .filter((a) => a.id !== "stub")
              .map(async (a) => ({
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
        case "agents.scan":
          return ok(req.id, { clis: await this.scanAll() });
        case "agents.capabilities":
          return ok(req.id, { probe: this.repo.getAgentProbe(req.params.provider) ?? null });
        case "system.activeTasks": {
          const row = this.db.$client
            .prepare(
              "select count(*) as n from tasks where state in ('queued','running','waiting_approval')",
            )
            .get() as { n: number };
          return ok(req.id, { count: Math.max(row.n, this.active.size) });
        }
        case "agents.getSettings":
          return ok(req.id, { settings: this.repo.getAgentSettings(req.params.provider) ?? null });
        case "agents.probe": {
          const r = await this.tryAgentSettings(req.params.provider, req.params.settings);
          if ("reason" in r) return ok(req.id, { ok: false, reason: r.reason });
          return ok(req.id, { ok: r.ok, resolvedPath: r.checked.resolvedPath, probe: r.probe });
        }
        case "agents.setSettings": {
          const { provider, settings } = req.params;
          if (settings === null) {
            this.repo.clearAgentSettings(provider);
            this.registry.replace(this.buildCliAdapter(provider));
            return ok(req.id, { ok: true, settings: null });
          }
          const r = await this.tryAgentSettings(provider, settings);
          if ("reason" in r) return ok(req.id, { ok: false, reason: r.reason });
          if (!r.ok) {
            // Not saved: a setting that cannot start the CLI must not replace one that works.
            return ok(req.id, {
              ok: false,
              reason:
                r.probe.error?.message ??
                (r.probe.status === "ok"
                  ? `This program does not look like the ${provider} CLI (its help shows none of the expected options)`
                  : `The probe reported ${r.probe.status}`),
              probe: r.probe,
            });
          }
          this.repo.saveAgentSettings({
            provider,
            ...r.checked.settings,
            verifiedAt: r.probe.probedAt,
          });
          this.repo.saveAgentProbe({
            provider: r.probe.provider,
            status: r.probe.status,
            ...(r.probe.path !== undefined ? { path: r.probe.path } : {}),
            ...(r.probe.version !== undefined ? { version: r.probe.version } : {}),
            capabilities: r.probe.capabilities,
            probedAt: r.probe.probedAt,
          });
          this.registry.replace(this.buildCliAdapter(provider, r.checked.settings));
          return ok(req.id, {
            ok: true,
            resolvedPath: r.checked.resolvedPath,
            settings: this.repo.getAgentSettings(provider) ?? null,
            probe: r.probe,
          });
        }
        case "projects.create": {
          const checked = checkProjectRoot(req.params.rootPath, this.rootPolicy);
          if (!checked.ok) return fail(req.id, checked.reason);
          const same = duplicateOf(checked.path, this.repo.listProjects());
          if (same !== undefined) {
            return fail(req.id, `This folder is already the project "${same}"`);
          }
          return ok(req.id, { projectId: this.repo.createProject(req.params.name, checked.path) });
        }
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
          const bad = this.rootProblem(root.rootPath);
          if (bad) return fail(req.id, bad);
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
            .catch((err: unknown) =>
              this.log.error({ err: this.redactor.text(String(err)) }, "background task failed"),
            )
            .finally(() => this.active.delete(taskId));
          const entry = this.active.get(taskId);
          if (entry) entry.done = run.then(() => undefined);
          return ok(req.id, { taskId });
        }
        case "tasks.cancel": {
          const state = this.repo.getTaskState(req.params.taskId);
          if (state === undefined) return fail(req.id, `Unknown task: ${req.params.taskId}`);
          if (this.scheduler.cancel(req.params.taskId)) {
            return ok(req.id, { requested: true, state });
          }
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
        case "tasks.resolveReconciliation": {
          const { taskId, decision, note } = req.params;
          const state = this.repo.getTaskState(taskId);
          if (state === undefined) return fail(req.id, `Unknown task: ${taskId}`);
          // Only an explicit user decision gets here; `requeue` is the one path that re-runs work.
          this.orchestrator.resolveReconciliation(taskId, decision, note);
          // The decision may unblock a workflow (e.g. `completed` hands over to the reviewer).
          const wf = this.repo.getTaskWorkflowId(taskId);
          if (wf) {
            this.scheduler.start(this.opts.schedulerIntervalMs); // a requeued task needs a running scheduler
            await this.engine.resume(wf);
          }
          const next = this.repo.getTaskState(taskId);
          if (next !== undefined) {
            this.opts.onEvent?.({
              event: "task.state",
              taskId,
              state: next,
              reason: `reconciled by user: ${note}`,
            });
          }
          return ok(req.id, { state: next });
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
        case "tasks.list": {
          const workflowState = this.repo.getWorkflowState(req.params.workflowId);
          if (!workflowState) return fail(req.id, `Unknown workflow: ${req.params.workflowId}`);
          return ok(req.id, { workflowState, tasks: this.repo.listTasks(req.params.workflowId) });
        }
        case "tasks.history":
          return ok(req.id, { tasks: this.repo.listTaskHistory(req.params) });
        case "logs.search": {
          const hits = this.repo.searchMessages(req.params).map((h) => ({
            taskId: h.taskId,
            sequence: h.sequence,
            type: h.type,
            createdAt: h.createdAt,
            snippet: snippetAround(h.payloadJson, req.params.query),
          }));
          return ok(req.id, { hits });
        }
        case "workflows.startPeerReview": {
          const p = req.params;
          if (!this.repo.getWorkflowState(p.workflowId)) {
            return fail(req.id, `Unknown workflow: ${p.workflowId}`);
          }
          for (const agent of [p.implementerAgent, p.reviewerAgent]) {
            if (!this.registry.get(agent)) return fail(req.id, `Unknown agent: ${agent}`);
          }
          const peerRoot = this.repo.getWorkflowRoot(p.workflowId);
          const badRoot = peerRoot ? this.rootProblem(peerRoot.rootPath) : null;
          if (badRoot) return fail(req.id, badRoot);
          // Refuse a workflow that already started before roles are rewritten (start() checks again).
          const from = this.repo.getWorkflowState(p.workflowId)!;
          if (!canTransitionWorkflow(from, "running")) {
            return fail(
              req.id,
              `Illegal workflow transition for ${p.workflowId}: ${from} -> running`,
            );
          }
          this.engine.defineRoles(p.workflowId, {
            implementerAgent: p.implementerAgent,
            reviewerAgent: p.reviewerAgent,
          });
          this.engine.start({
            workflowId: p.workflowId,
            goal: p.goal,
            ...(p.maxRounds !== undefined ? { maxRounds: p.maxRounds } : {}),
          });
          this.scheduler.start(this.opts.schedulerIntervalMs);
          return ok(req.id, { workflowId: p.workflowId, state: "running" });
        }
        case "roles.list":
          return ok(req.id, { roles: this.repo.listRoles(req.params.workflowId) });
        case "context.list":
          return ok(req.id, { items: this.repo.listContextItems(req.params.workflowId) });
        case "approvals.list": {
          this.approvals.expireDue();
          return ok(req.id, { approvals: this.repo.listApprovals(req.params.state) });
        }
        case "approvals.resolve": {
          this.approvals.expireDue();
          this.approvals.resolve(req.params.approvalId, req.params.decision, req.params.note);
          return ok(req.id, { resolved: true });
        }
        case "artifacts.list":
          return ok(req.id, { artifacts: this.artifacts.verify(req.params.taskId) });
        case "artifacts.diff":
          return ok(req.id, await this.artifacts.diff(req.params.taskId));
        case "worktrees.list":
          return ok(req.id, { worktrees: this.repo.listWorktrees(req.params.workflowId) });
        case "shutdown":
          return { response: { id: req.id, result: { ok: true } }, shutdown: true };
      }
    } catch (err) {
      return {
        response: { id: req.id, error: { message: this.redactor.text(String(err)) } },
        shutdown: false,
      };
    }
  }

  /** Resolves when every background task has settled (tests, graceful shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.active.values()].map((a) => a.done));
  }

  close(): void {
    this.scheduler.stop();
    for (const a of this.active.values()) a.abort.abort();
    if (this.db.$client.open) this.db.$client.close();
  }
}

export { createLogger };
