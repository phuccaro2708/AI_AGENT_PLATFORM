import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  AgentMessage,
  IllegalTransitionError,
  canTransition,
  type TaskState,
} from "@agent-studio/contracts";
import { newId } from "@agent-studio/shared-utils";
import type { StudioDb } from "./db.js";
import { agents, events, executionRuns, messages, projects, tasks, workflows } from "./schema.js";

const now = () => new Date().toISOString();

/** Thin repository layer. State change + event are written in ONE transaction. */
export class Repo {
  constructor(private readonly db: StudioDb) {}

  createProject(name: string, rootPath: string): string {
    const id = newId("prj");
    this.db.insert(projects).values({ id, name, rootPath, createdAt: now() }).run();
    return id;
  }

  createWorkflow(projectId: string): string {
    const id = newId("wf");
    this.db.insert(workflows).values({ id, projectId, state: "pending", createdAt: now() }).run();
    return id;
  }

  createTask(workflowId: string, agentId?: string): string {
    const id = newId("task");
    const ts = now();
    this.db
      .insert(tasks)
      .values({
        id,
        workflowId,
        agentId: agentId ?? null,
        state: "queued",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return id;
  }

  listProjects() {
    return this.db.select().from(projects).orderBy(asc(projects.createdAt)).all();
  }

  /** The project root a workflow runs in, or undefined when the workflow does not exist. */
  getWorkflowRoot(workflowId: string): { projectId: string; rootPath: string } | undefined {
    return this.db
      .select({ projectId: projects.id, rootPath: projects.rootPath })
      .from(workflows)
      .innerJoin(projects, eq(projects.id, workflows.projectId))
      .where(eq(workflows.id, workflowId))
      .get();
  }

  getTaskAttempt(taskId: string): number | undefined {
    return this.db.select({ a: tasks.attempt }).from(tasks).where(eq(tasks.id, taskId)).get()?.a;
  }

  getTaskState(taskId: string): TaskState | undefined {
    return this.db.select({ s: tasks.state }).from(tasks).where(eq(tasks.id, taskId)).get()?.s as
      TaskState | undefined;
  }

  /**
   * Atomically changes task state (guarded by the state machine) and appends an audit event.
   * Compare-and-set: the UPDATE only applies if the state is still the one the guard checked,
   * so a concurrent writer cannot make an illegal transition slip through.
   */
  setTaskState(
    taskId: string,
    state: TaskState,
    opts: { reason?: string; incrementAttempt?: boolean } = {},
  ): void {
    this.db.transaction((tx) => {
      const ts = now();
      const row = tx.select({ s: tasks.state }).from(tasks).where(eq(tasks.id, taskId)).get();
      if (!row) throw new Error(`Unknown task: ${taskId}`);
      const from = row.s as TaskState;
      if (!canTransition(from, state)) throw new IllegalTransitionError(taskId, from, state);
      const res = tx
        .update(tasks)
        .set({
          state,
          updatedAt: ts,
          ...(opts.incrementAttempt ? { attempt: sql`${tasks.attempt} + 1` } : {}),
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.state, from)))
        .run();
      if (res.changes !== 1) throw new Error(`Concurrent state change for task: ${taskId}`);
      tx.insert(events)
        .values({
          id: newId("evt"),
          aggregateId: taskId,
          eventType: "task.state_changed",
          payloadJson: JSON.stringify({
            from,
            state,
            ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          }),
          createdAt: ts,
        })
        .run();
    });
  }

  /**
   * Startup recovery: a task still `running`/`waiting_approval` belongs to a process that no longer
   * exists. Its side effects are unknown, so it becomes `needs_reconciliation` (CLAUDE.md principle 6);
   * nothing is re-run. Call once, before accepting work. Returns the affected task ids.
   */
  recoverInterruptedTasks(): string[] {
    const stuck = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.state, ["running", "waiting_approval"]))
      .all();
    for (const { id } of stuck) {
      this.setTaskState(id, "needs_reconciliation", {
        reason: "interrupted: the orchestrator stopped while this task was in progress",
      });
    }
    return stuck.map((s) => s.id);
  }

  /** Upserts the latest probe result for a provider (plain data; storage does not depend on cli-probe). */
  saveAgentProbe(p: {
    provider: string;
    status: string;
    path?: string;
    version?: string;
    capabilities: Record<string, boolean>;
    error?: unknown;
    probedAt: string;
  }): void {
    const row = {
      provider: p.provider,
      status: p.status,
      executablePath: p.path ?? null,
      version: p.version ?? null,
      capabilitiesJson: JSON.stringify(p.capabilities),
      errorJson: p.error === undefined ? null : JSON.stringify(p.error),
      probedAt: p.probedAt,
    };
    this.db
      .insert(agents)
      .values(row)
      .onConflictDoUpdate({ target: agents.provider, set: row })
      .run();
  }

  getAgentProbe(provider: string) {
    const r = this.db.select().from(agents).where(eq(agents.provider, provider)).get();
    if (!r) return undefined;
    return {
      provider: r.provider,
      status: r.status,
      path: r.executablePath ?? undefined,
      version: r.version ?? undefined,
      capabilities: JSON.parse(r.capabilitiesJson) as Record<string, boolean>,
      error: r.errorJson === null ? undefined : (JSON.parse(r.errorJson) as unknown),
      probedAt: r.probedAt,
    };
  }

  /** Records the launch of a process for a task attempt; returns the run id. */
  startRun(taskId: string, opts: { pid?: number; attempt?: number; sessionId?: string }): string {
    const id = newId("run");
    this.db
      .insert(executionRuns)
      .values({
        id,
        taskId,
        sessionId: opts.sessionId ?? null,
        attempt: opts.attempt ?? 0,
        pid: opts.pid ?? null,
        startedAt: now(),
      })
      .run();
    return id;
  }

  finishRun(runId: string, result: { exitCode: number | null; signal: string | null }): void {
    const res = this.db
      .update(executionRuns)
      .set({ exitCode: result.exitCode, signal: result.signal, endedAt: now() })
      .where(eq(executionRuns.id, runId))
      .run();
    if (res.changes !== 1) throw new Error(`Unknown run: ${runId}`);
  }

  getRun(runId: string) {
    return this.db.select().from(executionRuns).where(eq(executionRuns.id, runId)).get();
  }

  /** Validates and appends a message; sequence is assigned per task. */
  appendMessage(input: Omit<AgentMessage, "sequence">, sequence: number): void {
    const msg = AgentMessage.parse({ ...input, sequence });
    this.db
      .insert(messages)
      .values({
        id: msg.id,
        taskId: msg.taskId,
        sequence: msg.sequence,
        messageType: msg.type,
        payloadJson: JSON.stringify(msg),
        createdAt: msg.createdAt,
      })
      .run();
  }

  listMessages(taskId: string): AgentMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.taskId, taskId)))
      .orderBy(asc(messages.sequence))
      .all()
      .map((r) => AgentMessage.parse(JSON.parse(r.payloadJson)));
  }

  /** Messages with sequence > `afterSequence`, oldest first (cursor paging for the log view). */
  listMessagesAfter(taskId: string, afterSequence: number, limit: number): AgentMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.taskId, taskId), gt(messages.sequence, afterSequence)))
      .orderBy(asc(messages.sequence))
      .limit(limit)
      .all()
      .map((r) => AgentMessage.parse(JSON.parse(r.payloadJson)));
  }

  listAgentProbes() {
    return this.db
      .select({ provider: agents.provider })
      .from(agents)
      .all()
      .map((r) => this.getAgentProbe(r.provider))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
  }

  listEvents(aggregateId: string) {
    return this.db
      .select()
      .from(events)
      .where(eq(events.aggregateId, aggregateId))
      .orderBy(asc(events.createdAt))
      .all();
  }
}
