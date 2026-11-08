import {
  canTransitionWorkflow,
  ResourceSettings,
  SidecarRequest,
  type AgentCapability,
  type SidecarEvent,
  type TaskState,
  type SidecarResponse,
} from "@agent-studio/contracts";
import {
  AdapterRegistry,
  StubAdapter,
  type AgentAdapter,
  type AgentTask,
} from "@agent-studio/agent-core";
import {
  createSecretRedactor,
  noSecrets,
  type ProviderSecrets,
  type SecretRedactor,
} from "./secrets.js";
import { checkAgentSettings, type AgentLaunchSettings } from "./agent-settings.js";
import { evaluate } from "@agent-studio/policy-engine";
import { ClaudeAdapter } from "@agent-studio/adapter-claude";
import { CodexAdapter, CodexAppServerAdapter } from "@agent-studio/adapter-codex";
import type { CodexAppServerOptions } from "@agent-studio/adapter-codex";
import { AntigravityAdapter } from "@agent-studio/adapter-antigravity";
import { OllamaAdapter, type OllamaAdapterOptions } from "@agent-studio/adapter-ollama";
import {
  probeClaude,
  probeCodex,
  scanClis,
  CLI_CANDIDATES,
  type ProbeOptions,
  type ProbeResult,
} from "@agent-studio/cli-probe";
import {
  DEFAULT_THRESHOLDS,
  ResourceMonitor,
  type ResourceSource,
} from "@agent-studio/resource-monitor";
import { exportDiagnostics, verifyDiagnostics } from "@agent-studio/diagnostics";
import { createLogger, type Logger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { liveChildPids, type JobWrapOptions } from "@agent-studio/process-manager";
import { dirname, join } from "node:path";
import { ApprovalService } from "./approvals.js";
import { ArtifactRegistry } from "./artifacts.js";
import { ContextBoard } from "./context-board.js";
import { describeRouteFailure, selectAgent, snapshotAdapters } from "./capability-router.js";
import { Orchestrator, type RunResult } from "./orchestrator.js";
import { Scheduler } from "./scheduler.js";
import { checkProjectRoot, duplicateOf } from "./project-policy.js";
import { claudeGateTaskArgs, type ClaudeGateLauncher } from "./claude-permission-gate.js";
import { appServerPolicy } from "./codex-app-server-gate.js";
import { PolicyGate } from "./policy-gate.js";
import {
  auditNote,
  buildEvidence,
  buildReport,
  planResolution,
  type RecoveryReport,
} from "./recovery.js";
import { PeerReviewEngine } from "./workflow-engine.js";
import { ProjectWorkspaces } from "./workspaces.js";

export interface SidecarOptions {
  dbPath: string;
  nativeBinding?: string;
  migrationsFolder?: string;
  /** Test seam: adapters to register in addition to the stub. */
  extraAdapters?: AgentAdapter[];
  /** The local Ollama agent (`ollama`): model, loopback URL, opt-in tools. Without a model it is registered but unavailable. */
  ollama?: OllamaAdapterOptions;
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
  /** Interval of the approval expiry sweep (default 5 s). */
  approvalSweepMs?: number;
  /**
   * Where CPU/RAM readings come from. When given, a {@link ResourceMonitor} (default thresholds) samples it
   * and the scheduler starts fewer tasks under load; when absent there is no monitor and the scheduler runs
   * at its fixed concurrency. The real process passes `NodeResourceSource` (sidecar-main); tests pass a fake
   * or nothing, so they never read the real machine.
   */
  resourceSource?: ResourceSource;
  /** How often the resource monitor samples. Default 1000. */
  resourceSampleMs?: number;
  /** Tasks the scheduler runs at once at most (the resource monitor can only lower it). Default 2. */
  schedulerConcurrency?: number;
  /** Test seam: replaces the Policy Engine's `evaluate` in the pre-run gate (the real one never throws). */
  policyEvaluate?: typeof evaluate;
  /**
   * Test seam: also check the program `extraAdapters` report in `describeLaunch`. Off by default because those
   * adapters come from the embedding code, not from user settings; their folder is always checked.
   */
  policyCheckExtraLaunch?: boolean;
  /** How often a gate waiting for an approval looks at the task. Default 200 ms. */
  policyPollMs?: number;
  /**
   * Codex permission gate (P4-1 c): approval requests go through the Policy Engine. ON by default (Q3, 2026-11-07);
   * `false` switches it off (real process: `AGENT_STUDIO_CODEX_GATE=0`). While ON, the `codex` agent itself runs the
   * app-server adapter (ADR-008; stored `codex exec` args are not used) and `codex-app-server` stays registered too;
   * `false` restores `codex exec` and drops `codex-app-server`. The fields are launch overrides for the embedding
   * code (tests point them at a fake server); when `command` is set the program itself is not re-checked, as for
   * `extraAdapters`. Without `command` the `codex` program is checked by the policy gate; if it is missing the
   * task is refused.
   */
  codexAppServer?: Pick<CodexAppServerOptions, "command" | "baseArgs" | "env" | "envAllow"> | false;
  /**
   * P4-1 d: launch `claude` with `--permission-prompt-tool` so tool calls it did not settle itself are judged by
   * the Policy Engine, with `askEveryTool` (all six tools go to the gate) and `--setting-sources local`.
   * ON by default (Q3, 2026-11-07); `false` switches it off (real process: `AGENT_STUDIO_CLAUDE_GATE=0`).
   * Fail closed: `--safe-mode` is turned off (it would stop the gate from loading, d3), and a task is refused when
   * the launcher is missing or the stored arguments bring `--safe-mode` back. `configDir` (default: `gate` next to
   * the database) receives one MCP config file per task; `launcher` is the program claude starts as that MCP server
   * (default: this sidecar's own bundle, see `sidecar-main.ts`). `askEveryTool: false` is a test seam.
   * Not a sandbox: claude does not send every call to the gate (docs/SECURITY.md).
   */
  claudePermissionGate?:
    { configDir?: string; launcher?: ClaudeGateLauncher; askEveryTool?: boolean } | false;
  /**
   * P4-4 (b): start the `claude` and `codex` CLIs inside `agent-job-wrap` (Windows Job Object, kill on close).
   * Unset here = off. `sidecar-main` sets it by default when the installed binary is found (`job-wrap-config.ts`;
   * `AGENT_STUDIO_JOB_WRAP=0` turns it off; missing binary = warning and no wrap). Not applied to
   * `codex-app-server` or Antigravity.
   */
  jobWrap?: JobWrapOptions;
  /**
   * Opt-in (P4-4 (b)): kill the `claude`/`codex` process tree when its total resident memory passes this many MB
   * (host-side polling watchdog; the Job Object caps are per process). OFF by default (it only polls); set here,
   * or via `AGENT_STUDIO_CLI_TREE_MEM_MB=<positive MB>` in `sidecar-main`, to opt in.
   */
  cliTreeMemoryLimitMb?: number;
  /** Wall-clock limit of one `claude` run while its permission gate is on (ms, default 2 h; 0 = none). Backstop for a hung gate process. */
  claudeTaskTimeoutMs?: number;
  /** Parent folder of diagnostics bundles. Default: `diagnostics` next to the database. */
  diagnosticsDir?: string;
  /** Folder and file stem of the sidecar's log file (the native side redirects stderr there). Default: next to the database, `sidecar`. */
  logDir?: string;
  logBaseName?: string;
}

/** The program each built-in agent is launched as unless the user stored another (probed) command. */
const DEFAULT_COMMANDS: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  agy: "agy",
  "codex-app-server": "codex",
};

const ok = (id: number, result: unknown) => ({
  response: { id, result } as SidecarResponse,
  shutdown: false,
});
const fail = (id: number, message: string) => ({
  response: { id, error: { message } } as SidecarResponse,
  shutdown: false,
});

/** Where the load limits are stored (the `settings` table); the value is the JSON of a `ResourceSettings`. */
const RESOURCE_SETTINGS_KEY = "resources.v1";

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

/**
 * CLIs that have an adapter but no settings-aware probe yet: scanned like any other candidate
 * (generic help-based probe), yet allowed to run tasks. Their launch settings are not configurable.
 */
const SCAN_ONLY_ADAPTERS: ReadonlySet<string> = new Set(["agy"]);

/** Same requirement the UI applies to a single-agent task (`AGENT_TASK_REQUIRES`): a live log. */
const AUTO_AGENT_REQUIRES: readonly AgentCapability[] = ["streaming"];

const DEFAULT_CLAUDE_TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export class SidecarService {
  readonly db: StudioDb;
  private readonly repo: Repo;
  private readonly registry = new AdapterRegistry();
  private readonly orchestrator: Orchestrator;
  private readonly scheduler: Scheduler;
  private readonly resourceMonitor: ResourceMonitor | undefined;
  private readonly engine: PeerReviewEngine;
  private readonly approvals: ApprovalService;
  private readonly artifacts: ArtifactRegistry;
  /** Phase 0 spike workflow for `runStub`; created on first use so a normal start adds no project. */
  private spikeWorkflowId: string | undefined;
  /** The limits in force (P3-4, P3-5): what Settings saved, else the defaults. */
  private resourceSettings!: ResourceSettings;
  private readonly recoveredTasks: number;
  private readonly secrets: ProviderSecrets;
  private readonly redactor: SecretRedactor;
  private readonly probes: Record<"claude" | "codex", (o?: ProbeOptions) => Promise<ProbeResult>>;
  /** Callers of `runThroughScheduler` waiting for their task to settle. */
  private readonly settleWaiters = new Map<string, (r: RunResult | undefined) => void>();
  /** Pre-run policy check and post-run scope check around every agent (P4-1 a + b). */
  private readonly gate: PolicyGate;
  private gateWorkspaces: ProjectWorkspaces | undefined;

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
    // Q3 follow-up (2026-11-07, user decision): while the Codex gate is ON, the `codex` agent IS the app-server
    // adapter, so every command/file request goes through the Policy Engine. The stored `args` (`codex exec`
    // arguments) are not used. Switch back to `codex exec` with `codexAppServer:false` / AGENT_STUDIO_CODEX_GATE=0.
    if (provider === "codex" && this.opts.codexAppServer !== false) {
      return this.buildAppServerAdapter(s, "codex");
    }
    const secret = this.secrets[provider];
    // Variables the user (stored settings) or the native side (secrets) named on purpose may reach the child;
    // the rest of this process's environment is cut down by the adapter's own manifest (P4-3).
    const envAllow = [...Object.keys(s?.env ?? {}), ...Object.keys(secret)];
    const o = {
      ...(s || Object.keys(secret).length > 0
        ? {
            ...(s ? { command: s.command, extraArgs: s.args } : {}),
            env: this.childEnv(provider, s?.env ?? {}),
            envAllow,
          }
        : {}),
      ...(this.opts.jobWrap ? { jobWrap: this.opts.jobWrap } : {}),
      ...(this.opts.cliTreeMemoryLimitMb === undefined
        ? {}
        : { treeMemoryLimitMb: this.opts.cliTreeMemoryLimitMb }),
    };
    const gateOpt = this.opts.claudePermissionGate;
    if (provider === "claude" && gateOpt !== false) {
      const build = claudeGateTaskArgs({
        configDir: gateOpt?.configDir ?? join(dirname(this.opts.dbPath), "gate"),
        launcher: gateOpt?.launcher ?? { command: process.execPath, args: [process.argv[1] ?? ""] },
        askEveryTool: gateOpt?.askEveryTool ?? true,
        isolateSettings: true,
        requireLauncher: true,
      });
      const taskArgs = (task: AgentTask) => {
        // `--safe-mode` keeps the MCP gate from loading (d3): refuse instead of running without the gate.
        if ((s?.args ?? []).some((a) => a === "--safe-mode")) {
          throw new Error(
            "--safe-mode in the stored claude arguments is incompatible with the gate",
          );
        }
        return build(task);
      };
      const t = this.opts.claudeTaskTimeoutMs ?? DEFAULT_CLAUDE_TASK_TIMEOUT_MS;
      return this.gate.wrap(
        new ClaudeAdapter({ ...o, safeMode: false, taskArgs, ...(t > 0 ? { timeoutMs: t } : {}) }),
      );
    }
    return this.gate.wrap(provider === "claude" ? new ClaudeAdapter(o) : new CodexAdapter(o));
  }

  /**
   * `agents.scan`: every known candidate. CLIs with an adapter (`this.probes`) go through the same
   * settings-aware probe as `agents.detect` (which owns their stored row); the others are scanned
   * and their probe stored. Only `supported` CLIs may be picked to run tasks.
   */
  private async scanAll() {
    const supported = (id: string) => id in this.probes || SCAN_ONLY_ADAPTERS.has(id);
    const scanned = new Map(
      (
        await (this.opts.scan ?? scanClis)({
          candidates: CLI_CANDIDATES.filter((c) => !(c.id in this.probes)),
        })
      ).map((s) => [s.provider, s]),
    );
    const out = [];
    for (const c of CLI_CANDIDATES) {
      let r: ProbeResult & { usable?: boolean };
      if (c.id in this.probes) {
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

  /**
   * `codex-app-server`: the same program, environment and secrets as the stored `codex` settings (so a custom path,
   * proxy variable or Credential Manager key reaches it too); explicit `SidecarOptions.codexAppServer` fields win.
   * The stored `args` are NOT passed: they are `codex exec` arguments and were never probed for `app-server`.
   */
  private buildAppServerAdapter(
    s?: { command: string; args: string[]; env: Record<string, string> },
    id: "codex" | "codex-app-server" = "codex-app-server",
  ): AgentAdapter {
    const explicit = this.opts.codexAppServer || {};
    const secret = this.secrets.codex;
    const fromSettings =
      s || Object.keys(secret).length > 0
        ? {
            ...(s ? { command: s.command } : {}),
            env: this.childEnv("codex", s?.env ?? {}),
            envAllow: [...Object.keys(s?.env ?? {}), ...Object.keys(secret)],
          }
        : {};
    const appServer = { ...fromSettings, ...explicit };
    const run = this.opts.policyEvaluate ?? evaluate;
    return this.gate.wrap(
      new CodexAppServerAdapter({
        ...(this.opts.jobWrap ? { jobWrap: this.opts.jobWrap } : {}),
        ...(this.opts.cliTreeMemoryLimitMb === undefined
          ? {}
          : { treeMemoryLimitMb: this.opts.cliTreeMemoryLimitMb }),
        ...appServer,
        id,
        evaluate: async (request, ctx) =>
          run(appServerPolicy(ctx), request, { taskId: ctx.taskId }),
      }),
      { checkLaunch: appServer.command === undefined },
    );
  }

  /** A change of the `codex` settings also reaches `codex-app-server` (when it is registered). */
  private refreshAppServer(provider: "claude" | "codex"): void {
    if (provider !== "codex" || this.opts.codexAppServer === false) return;
    this.registry.replace(this.buildAppServerAdapter(this.repo.getAgentSettings("codex")));
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
    this.gate = new PolicyGate({
      repo: this.repo,
      log,
      approvals: () => this.approvals,
      workspaces: () => {
        if (!this.gateWorkspaces) throw new Error("workspaces are not ready");
        return this.gateWorkspaces;
      },
      allowedCommands: (agentId) => {
        const stored =
          agentId === "claude" || agentId === "codex"
            ? this.repo.getAgentSettings(agentId)?.command
            : undefined;
        const base = DEFAULT_COMMANDS[agentId];
        return [...(base ? [base] : []), ...(stored ? [stored] : [])];
      },
      redact: (t) => this.redactor.text(t),
      ...(opts.policyEvaluate ? { evaluate: opts.policyEvaluate } : {}),
      ...(opts.policyPollMs !== undefined ? { pollMs: opts.policyPollMs } : {}),
    });
    this.registry.register(new StubAdapter());
    this.registry.register(this.buildCliAdapter("claude", this.repo.getAgentSettings("claude")));
    this.registry.register(this.buildCliAdapter("codex", this.repo.getAgentSettings("codex")));
    this.registry.register(this.gate.wrap(new AntigravityAdapter()));
    this.registry.register(this.gate.wrap(new OllamaAdapter(opts.ollama ?? {})));
    if (opts.codexAppServer !== false) {
      this.registry.register(this.buildAppServerAdapter(this.repo.getAgentSettings("codex")));
    }
    for (const a of opts.extraAdapters ?? [])
      this.registry.register(
        this.gate.wrap(a, { checkLaunch: opts.policyCheckExtraLaunch === true }),
      );
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
    this.gateWorkspaces = workspaces;
    this.engine = new PeerReviewEngine({
      repo: this.repo,
      orchestrator: this.orchestrator,
      board: new ContextBoard(this.repo),
      workspaces,
    });
    this.resourceSettings = this.loadResourceSettings();
    if (opts.resourceSource) {
      this.resourceMonitor = new ResourceMonitor({
        source: opts.resourceSource,
        thresholds: this.resourceSettings.thresholds,
        trackedPids: liveChildPids, // the CLI agents' root pids (P3-2)
        onHealthChange: (healthy, d) =>
          healthy
            ? this.log.info("resource monitor measuring again")
            : this.log.warn(
                { failures: d.consecutiveFailures, err: this.redactor.text(String(d.error)) },
                "resource monitor cannot read the source: concurrency is reduced until it recovers",
              ),
      });
      this.resourceMonitor.start(opts.resourceSampleMs);
    }
    this.scheduler = new Scheduler({
      repo: this.repo,
      orchestrator: this.orchestrator,
      concurrency: this.resourceSettings.concurrency,
      ...(this.resourceMonitor ? { admission: this.resourceMonitor } : {}),
      onStarted: (id) => opts.onEvent?.({ event: "task.state", taskId: id, state: "running" }),
      onSettled: (id, result) => {
        const waiter = this.settleWaiters.get(id);
        this.settleWaiters.delete(id);
        waiter?.(result);
        return this.engine.onSettled(id, result);
      },
    });
    // Workflows left `running` by a previous exit need the scheduler again (it starts lazily otherwise).
    // Single tasks held by admission stay `queued` in a `pending` workflow, so they need it too.
    if (this.repo.listWorkflowIdsByState("running").length > 0 || this.queuedCount() > 0) {
      this.scheduler.start(opts.schedulerIntervalMs);
    }
    void this.engine
      .resumeAll()
      .catch((err) => log.error({ err: this.redactor.text(String(err)) }, "resume failed"));
    this.approvals = new ApprovalService({ repo: this.repo });
    this.approvals.startTimer(opts.approvalSweepMs, (err) =>
      log.error({ err: this.redactor.text(String(err)) }, "approval expiry sweep failed"),
    );
    this.artifacts = new ArtifactRegistry(this.repo, workspaces);
  }

  /**
   * P4-6: a folder with versions, configuration, recent log and a task summary, masked a second time with
   * every secret this process knows (provider secrets and the env values stored in agent settings) and
   * read back before it is reported. The UI cannot choose the folder; a leak aborts the export.
   */
  private exportDiagnosticsBundle() {
    const stored = (["claude", "codex"] as const).map(
      (p) => [p, this.repo.getAgentSettings(p)] as const,
    );
    const secrets = [
      ...Object.values(this.secrets).flatMap((p) => Object.values(p)),
      ...stored.flatMap(([, s]) => Object.values(s?.env ?? {})),
    ];
    const counts = this.db.$client
      .prepare("select state, count(*) as n from tasks group by state")
      .all() as { state: string; n: number }[];
    const result = exportDiagnostics({
      outDir: this.opts.diagnosticsDir ?? join(dirname(this.opts.dbPath), "diagnostics"),
      logDir: this.opts.logDir ?? dirname(this.opts.dbPath),
      logBaseName: this.opts.logBaseName ?? "sidecar",
      versions: { sidecar: "0.0.0", node: process.version, platform: process.platform },
      config: {
        projects: this.repo.listProjects().length,
        tasksByState: Object.fromEntries(counts.map((c) => [c.state, c.n])),
        agentSettings: Object.fromEntries(
          stored.map(([p, s]) => [
            p,
            s ? { command: s.command, args: s.args, env: s.env, verifiedAt: s.verifiedAt } : null,
          ]),
        ),
      },
      attachments: [
        {
          name: "tasks.json",
          content: JSON.stringify(this.repo.listTaskHistory({ limit: 200, offset: 0 }), null, 2),
        },
      ],
      secrets,
    });
    const check = verifyDiagnostics(result.dir);
    return {
      dir: result.dir,
      manifestPath: result.manifestPath,
      files: result.manifest.files.map((f) => ({ path: f.path, bytes: f.bytes })),
      verified: check.ok,
      problems: check.problems,
      limits: result.manifest.redaction.limits,
    };
  }

  /** P4-8 steps 2 and 3: evidence and classification for a task. Read-only; undefined when the task is unknown. */
  private async recoveryReport(taskId: string): Promise<RecoveryReport | undefined> {
    const task = this.repo.getTask(taskId);
    if (!task) return undefined;
    const has = this.repo.getWorktreeForTask(taskId) !== undefined;
    let changed: boolean | null = null;
    if (has) {
      try {
        changed = (await this.artifacts.diff(taskId)).patch.trim().length > 0;
      } catch {
        changed = null; // unreadable is not "clean": the classification treats it as unverified
      }
    }
    return buildReport({
      taskId,
      state: task.state as TaskState,
      attempt: task.attempt,
      evidence: buildEvidence(this.repo.listMessages(taskId), { has, changed }),
    });
  }

  /** After a reconciliation decision: let the workflow continue (or run a requeued task) and announce the state. */
  private async afterReconciliation(taskId: string, note: string): Promise<TaskState | undefined> {
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
    return next;
  }

  /**
   * Text for the native confirmation dialog (T12). Everything shown comes from validated parameters and the
   * stored state, masked by the redactor and shortened; a request that could not succeed (unknown or already
   * answered approval, unknown task) throws, so the shell shows no dialog for it.
   */
  private async describeForConfirmation(
    req: SidecarRequest,
  ): Promise<{ title: string; message: string }> {
    // Free text may be shortened, but never silently: the dialog says how much is not shown.
    const clip = (t: string, n: number) =>
      t.length > n ? `${t.slice(0, n)} [\u2026 ${t.length - n} more characters NOT shown]` : t;
    const text = (t: string, n: number) => clip(this.redactor.text(t), n);
    // For what decides WHICH program runs, a shortened view could hide the dangerous part: refuse instead.
    const whole = (what: string, t: string, n: number) => {
      if (t.length > n)
        throw new Error(`${what} is too long to confirm safely (over ${n} characters)`);
      return this.redactor.text(t);
    };
    switch (req.method) {
      case "approvals.resolve": {
        const a = this.repo.getApproval(req.params.approvalId);
        if (!a) throw new Error(`Unknown approval: ${req.params.approvalId}`);
        if (a.state !== "pending") throw new Error(`Approval is already ${a.state}: ${a.id}`);
        const verb = req.params.decision === "approved" ? "APPROVE" : "DENY";
        return {
          title: `${verb} a task's request?`,
          message:
            `Decision: ${verb}\nTask: ${a.taskId}\nScope: ${req.params.scope}\n` +
            `Request: ${text(a.requestJson, 1200)}\n` +
            (req.params.note ? `Note: ${text(req.params.note, 300)}\n` : "") +
            "\nThe agent will act on this answer.",
        };
      }
      case "tasks.resolveReconciliation": {
        const state = this.repo.getTaskState(req.params.taskId);
        if (state === undefined) throw new Error(`Unknown task: ${req.params.taskId}`);
        const rerun = req.params.decision === "requeue" ? "\nThe task will run again." : "";
        return {
          title: "Settle a task with unknown side effects?",
          message:
            `Task: ${req.params.taskId} (now ${state})\nDecision: ${req.params.decision}\n` +
            `Note: ${text(req.params.note, 600)}${rerun}\n\nOnly confirm if you checked what the task changed.`,
        };
      }
      case "recovery.resolve": {
        const report = await this.recoveryReport(req.params.taskId);
        if (!report) throw new Error(`Unknown task: ${req.params.taskId}`);
        const decision = planResolution(report, req.params.action, req.params.confirmUnverified);
        const e = report.evidence;
        return {
          title: "Recover a stopped task?",
          message:
            `Task: ${report.taskId} (${report.state}, attempt ${report.attempt})\n` +
            `Action: ${req.params.action} (stored as: ${decision})\n` +
            `Evidence: ${report.classification}; tool calls ${e.toolCalls}, unfinished ${e.unfinishedToolCalls}, ` +
            `worktree ${!e.hasWorktree ? "none" : e.worktreeChanged === null ? "unreadable" : e.worktreeChanged ? "changed" : "clean"}\n` +
            `Checked by the person: ${req.params.confirmUnverified ? "yes" : "no"}\n` +
            `Note: ${text(req.params.note, 600)}`,
        };
      }
      case "agents.setSettings": {
        const { provider, settings } = req.params;
        if (settings === null) {
          return {
            title: `Reset the ${provider} CLI settings?`,
            message: `The ${provider} agent goes back to its default program and arguments.`,
          };
        }
        const envNames = Object.keys(settings.env);
        return {
          title: `Change the program the ${provider} agent runs?`,
          message:
            `Provider: ${provider}\nProgram: ${whole("The program", settings.command, 400)}\n` +
            `Arguments: ${whole("The arguments", JSON.stringify(settings.args), 600)}\n` +
            `Environment variables set: ${envNames.length === 0 ? "none" : whole("The environment variable names", envNames.join(", "), 300)}\n` +
            "\nTasks for this agent will launch this program.",
        };
      }
      case "agents.probe": {
        const { provider, settings } = req.params;
        const envNames = Object.keys(settings.env);
        return {
          title: `Run this program to probe the ${provider} agent?`,
          message:
            `Provider: ${provider}\nProgram: ${whole("The program", settings.command, 400)}\n` +
            `Arguments: ${whole("The arguments", JSON.stringify(settings.args), 600)}\n` +
            `Environment variables set: ${envNames.length === 0 ? "none" : whole("The environment variable names", envNames.join(", "), 300)}\n` +
            `\nThe program will be RUN now (version/help check) with the ${provider} secrets in its environment.`,
        };
      }
      default:
        throw new Error(`No confirmation is defined for ${req.method}`);
    }
  }

  /**
   * Every single-task path goes through the scheduler, so the same admission (concurrency ceiling and the
   * resource monitor's reduced/paused levels) applies. The task is queued first; when admission refuses, it
   * stays `queued` and the scheduler timer starts it once the load drops. Returns the task id at once and
   * `settled`, which resolves with the result when the task has run to its end.
   */
  private async runThroughScheduler(opts: {
    workflowId: string;
    agentId: string;
    prompt: string;
    cwd: string;
  }): Promise<{ taskId: string; settled: Promise<RunResult | undefined> }> {
    // `enqueue` stores the prompt as the task's `task.request` (and the UI receives it), so a secret the
    // user typed is masked here, exactly as the Peer Review goal is; the agent then runs the masked prompt.
    const taskId = this.orchestrator.enqueue({ ...opts, prompt: this.redactor.text(opts.prompt) });
    const settled = new Promise<RunResult | undefined>((resolve) =>
      this.settleWaiters.set(taskId, resolve),
    );
    this.scheduler.start(this.opts.schedulerIntervalMs);
    await this.scheduler.tick();
    return { taskId, settled };
  }

  /** Defaults: the monitor's own default thresholds and the embedding's concurrency (2 when it names none). */
  private defaultResourceSettings(): ResourceSettings {
    const { cpu, memory, releaseMarginPercent } = DEFAULT_THRESHOLDS;
    return {
      concurrency: this.opts.schedulerConcurrency ?? 2,
      thresholds: { cpu: { ...cpu }, memory: { ...memory }, releaseMarginPercent },
    };
  }

  /** What Settings saved earlier. Anything unreadable or out of bounds falls back to the defaults, with a warning. */
  private loadResourceSettings(): ResourceSettings {
    const text = this.repo.getSetting(RESOURCE_SETTINGS_KEY);
    if (text === undefined) return this.defaultResourceSettings();
    try {
      return ResourceSettings.parse(JSON.parse(text));
    } catch (err) {
      this.log.warn(
        { err: this.redactor.text(String(err)) },
        "stored load limits are invalid: using the defaults",
      );
      return this.defaultResourceSettings();
    }
  }

  private queuedCount(): number {
    return this.db.$client
      .prepare("select count(*) from tasks where state = 'queued'")
      .pluck()
      .get() as number;
  }

  /** The limits in force and what the resource monitor says now (level and the reasons for it). */
  private resourceReport() {
    const snap = this.resourceMonitor?.snapshot();
    const base = this.resourceSettings.concurrency;
    const queued = this.queuedCount();
    return {
      settings: this.resourceSettings,
      defaults: this.defaultResourceSettings(),
      status: {
        concurrency: base,
        effectiveConcurrency: this.resourceMonitor
          ? this.resourceMonitor.maxConcurrency(base)
          : base,
        running: this.scheduler.runningCount,
        queued,
        monitor: snap
          ? {
              level: snap.level,
              reasons: snap.reasons,
              measured: snap.measured,
              ...snap.metrics,
              sampledAtMs: snap.sampledAtMs,
            }
          : null,
      },
    };
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
          const { taskId, settled } = await this.runThroughScheduler({
            workflowId: this.spikeWorkflow(),
            agentId: "stub",
            prompt: req.params.prompt,
            cwd: process.cwd(),
          });
          // IPC requests are served one at a time (sidecar-main), so a task that admission is holding back must
          // not be awaited here: it would block `tasks.cancel` and everything behind it. It stays queued.
          if (this.repo.getTaskState(taskId) === "queued") {
            this.settleWaiters.delete(taskId);
            return ok(req.id, {
              taskId,
              finalState: "queued",
              eventCount: 0,
              messageCount: this.repo.listMessages(taskId).length,
            });
          }
          const r = await settled;
          const finalState = r?.finalState ?? this.repo.getTaskState(taskId) ?? "failed";
          return {
            response: {
              id: req.id,
              result: {
                taskId,
                finalState,
                eventCount: r?.events.length ?? 0,
                messageCount: this.repo.listMessages(taskId).length,
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
            // Same probe as the one that will launch tasks: stored command/env when set, else PATH.
            const r = await this.probeStored(p);
            this.saveProbe(r);
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
          return ok(req.id, { count: row.n });
        }
        case "confirm.describe": {
          // The inner call must be exactly what the real call would accept; anything else is refused.
          const inner = SidecarRequest.safeParse({
            id: 0,
            method: req.params.method,
            params: req.params.params,
          });
          if (!inner.success) return fail(req.id, `invalid ${req.params.method} request`);
          return ok(req.id, await this.describeForConfirmation(inner.data));
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
            this.refreshAppServer(provider);
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
          this.refreshAppServer(provider);
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
          let agentId = req.params.agentId;
          if (agentId === undefined) {
            // No agent named: pick by declared capability, never by name. The stub is an internal
            // fixture and is not a candidate. A named agent is honoured as before (the UI gates it).
            const route = selectAgent(await snapshotAdapters(this.registry), AUTO_AGENT_REQUIRES, {
              exclude: ["stub", ...(req.params.excludeAgents ?? [])],
            });
            if (!route.ok) return fail(req.id, describeRouteFailure(route, AUTO_AGENT_REQUIRES));
            agentId = route.agentId;
          } else if (!this.registry.get(agentId)) {
            return fail(req.id, `Unknown agent: ${agentId}`);
          }
          const bad = this.rootProblem(root.rootPath);
          if (bad) return fail(req.id, bad);
          // Runs in the background so `tasks.cancel` and other requests are served meanwhile.
          const { taskId } = await this.runThroughScheduler({
            workflowId: req.params.workflowId,
            agentId,
            prompt: req.params.prompt,
            cwd: root.rootPath,
          });
          return ok(req.id, { taskId });
        }
        case "tasks.cancel": {
          const state = this.repo.getTaskState(req.params.taskId);
          if (state === undefined) return fail(req.id, `Unknown task: ${req.params.taskId}`);
          if (this.scheduler.cancel(req.params.taskId)) {
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
          const { taskId, decision } = req.params;
          const note = this.redactor.text(req.params.note); // free text from the user ends up in reason + event
          const state = this.repo.getTaskState(taskId);
          if (state === undefined) return fail(req.id, `Unknown task: ${taskId}`);
          // Only an explicit user decision gets here; `requeue` is the one path that re-runs work.
          this.orchestrator.resolveReconciliation(taskId, decision, note);
          // The decision may unblock a workflow (e.g. `completed` hands over to the reviewer).
          return ok(req.id, { state: await this.afterReconciliation(taskId, note) });
        }
        case "recovery.inspect": {
          const report = await this.recoveryReport(req.params.taskId);
          if (!report) return fail(req.id, `Unknown task: ${req.params.taskId}`);
          return ok(req.id, report);
        }
        case "recovery.resolve": {
          const { taskId, action, confirmUnverified } = req.params;
          const report = await this.recoveryReport(taskId);
          if (!report) return fail(req.id, `Unknown task: ${taskId}`);
          const decision = planResolution(report, action, confirmUnverified);
          // Free text from the user ends up in the reason and in the event, so it is masked first.
          const note = auditNote(report, action, this.redactor.text(req.params.note));
          this.orchestrator.resolveReconciliation(taskId, decision, note);
          return ok(req.id, { state: await this.afterReconciliation(taskId, note) });
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
            goal: this.redactor.text(p.goal), // stored as a context item and task.request, then returned to the UI
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
          this.approvals.resolve(
            req.params.approvalId,
            req.params.decision,
            req.params.note === undefined ? undefined : this.redactor.text(req.params.note),
            req.params.scope,
          );
          return ok(req.id, { resolved: true });
        }
        case "artifacts.list":
          return ok(req.id, { artifacts: this.artifacts.verify(req.params.taskId) });
        case "artifacts.diff":
          return ok(req.id, await this.artifacts.diff(req.params.taskId));
        case "worktrees.list":
          return ok(req.id, { worktrees: this.repo.listWorktrees(req.params.workflowId) });
        case "diagnostics.export":
          return ok(req.id, this.exportDiagnosticsBundle());
        case "resources.get":
          return ok(req.id, this.resourceReport());
        case "resources.set": {
          const next = req.params.settings;
          // Monitor first: it re-validates and throws before anything is stored or applied.
          this.resourceMonitor?.setThresholds(next.thresholds);
          this.scheduler.setConcurrency(next.concurrency);
          this.repo.setSetting(RESOURCE_SETTINGS_KEY, JSON.stringify(next));
          this.resourceSettings = next;
          this.resourceMonitor?.sample(); // decide with the new numbers now, not a second later
          this.log.info({ concurrency: next.concurrency }, "load limits changed");
          // A raised ceiling (or looser brakes) may free a slot for tasks that were being held back.
          if (this.queuedCount() > 0) {
            this.scheduler.start(this.opts.schedulerIntervalMs);
            await this.scheduler.tick();
          }
          return ok(req.id, this.resourceReport());
        }
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
    await this.scheduler.idle();
  }

  close(): void {
    this.approvals.stopTimer();
    this.scheduler.stop();
    this.resourceMonitor?.stop();
    for (const resolve of this.settleWaiters.values()) resolve(undefined);
    this.settleWaiters.clear();
    if (this.db.$client.open) this.db.$client.close();
  }
}

export { createLogger };
