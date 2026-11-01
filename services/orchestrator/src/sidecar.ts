import { SidecarRequest, type SidecarResponse } from "@agent-studio/contracts";
import { AdapterRegistry, StubAdapter } from "@agent-studio/agent-core";
import { createLogger, type Logger } from "@agent-studio/shared-utils";
import { openDatabase, runMigrations, Repo, type StudioDb } from "@agent-studio/storage";
import { Orchestrator } from "./orchestrator.js";

export interface SidecarOptions {
  dbPath: string;
  nativeBinding?: string;
  migrationsFolder?: string;
}

/** Transport-independent request handler (unit-testable). */
export class SidecarService {
  readonly db: StudioDb;
  private readonly repo: Repo;
  private readonly orchestrator: Orchestrator;
  private readonly workflowId: string;

  constructor(
    private readonly opts: SidecarOptions,
    log: Logger,
  ) {
    this.db = openDatabase(
      opts.dbPath,
      opts.nativeBinding ? { nativeBinding: opts.nativeBinding } : {},
    );
    if (opts.migrationsFolder) runMigrations(this.db, opts.migrationsFolder);
    else runMigrations(this.db);
    this.repo = new Repo(this.db);
    const registry = new AdapterRegistry();
    registry.register(new StubAdapter());
    this.orchestrator = new Orchestrator(registry, this.repo, log);
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
        case "shutdown":
          return { response: { id: req.id, result: { ok: true } }, shutdown: true };
      }
    } catch (err) {
      return { response: { id: req.id, error: { message: String(err) } }, shutdown: false };
    }
  }

  close(): void {
    if (this.db.$client.open) this.db.$client.close();
  }
}

export { createLogger };
