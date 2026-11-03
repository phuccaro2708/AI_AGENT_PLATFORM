import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  AgentMessage,
  IllegalTransitionError,
  canTransition,
  type TaskState,
} from "@agent-studio/contracts";
import { newId } from "@agent-studio/shared-utils";
import type { StudioDb } from "./db.js";
import {
  agents,
  events,
  executionRuns,
  inbox,
  messages,
  outbox,
  projects,
  taskDependencies,
  tasks,
  workflows,
  worktrees,
} from "./schema.js";

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

  createTask(workflowId: string, agentId?: string, opts: { priority?: number } = {}): string {
    const id = newId("task");
    const ts = now();
    this.db
      .insert(tasks)
      .values({
        id,
        workflowId,
        agentId: agentId ?? null,
        state: "queued",
        priority: opts.priority ?? 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return id;
  }

  /**
   * `taskId` waits for `dependencyId`. Both must be in the same workflow and the edge must not
   * close a cycle (checked inside the transaction). Re-adding an existing edge is a no-op.
   */
  addDependency(taskId: string, dependencyId: string): void {
    if (taskId === dependencyId) throw new Error("a task cannot depend on itself");
    this.db.transaction((tx) => {
      const pair = tx
        .select({ id: tasks.id, wf: tasks.workflowId })
        .from(tasks)
        .where(inArray(tasks.id, [taskId, dependencyId]))
        .all();
      if (pair.length !== 2) throw new Error("unknown task in dependency");
      if (pair[0]!.wf !== pair[1]!.wf) throw new Error("dependency must be in the same workflow");
      // cycle iff taskId is reachable from dependencyId by following "depends on" edges
      const seen = new Set<string>();
      const stack = [dependencyId];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === taskId) throw new Error(`dependency cycle: ${taskId} <-> ${dependencyId}`);
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const e of tx
          .select({ d: taskDependencies.dependencyId })
          .from(taskDependencies)
          .where(eq(taskDependencies.taskId, cur))
          .all())
          stack.push(e.d);
      }
      tx.insert(taskDependencies).values({ taskId, dependencyId }).onConflictDoNothing().run();
    });
  }

  /**
   * Atomically starts the best ready task: `queued`, every dependency `completed`, highest priority
   * then oldest. Returns undefined when nothing is ready or `maxConcurrent` tasks are already running.
   */
  claimNextReady(o: { now: string; leaseMs: number; maxConcurrent: number }): string | undefined {
    return this.db.transaction((tx) => {
      const running = tx
        .select({ n: sql<number>`count(*)` })
        .from(tasks)
        .where(eq(tasks.state, "running"))
        .get()!.n;
      if (running >= o.maxConcurrent) return undefined;
      const next = tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.state, "queued"),
            sql`NOT EXISTS (SELECT 1 FROM ${taskDependencies} d JOIN ${tasks} dep ON dep.id = d.dependency_id WHERE d.task_id = ${tasks.id} AND dep.state != 'completed')`,
          ),
        )
        .orderBy(desc(tasks.priority), asc(tasks.createdAt), asc(tasks.id))
        .limit(1)
        .get();
      if (!next) return undefined;
      this.setTaskState(next.id, "running", {
        leaseExpiresAt: new Date(Date.parse(o.now) + o.leaseMs).toISOString(),
      });
      return next.id;
    });
  }

  /** Queued tasks that can never start because a dependency ended failed/cancelled/needs_reconciliation. */
  listBlockedTasks(): string[] {
    return this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.state, "queued"),
          sql`EXISTS (SELECT 1 FROM ${taskDependencies} d JOIN ${tasks} dep ON dep.id = d.dependency_id WHERE d.task_id = ${tasks.id} AND dep.state IN ('failed','cancelled','needs_reconciliation'))`,
        ),
      )
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .all()
      .map((r) => r.id);
  }

  /** Extends the lease of a `running` task; false when the task is no longer running. */
  heartbeat(taskId: string, nowIso: string, leaseMs: number): boolean {
    return (
      this.db
        .update(tasks)
        .set({ leaseExpiresAt: new Date(Date.parse(nowIso) + leaseMs).toISOString() })
        .where(and(eq(tasks.id, taskId), eq(tasks.state, "running")))
        .run().changes === 1
    );
  }

  /**
   * `running` tasks whose lease has lapsed lost their worker: side effects unknown, so they become
   * `needs_reconciliation` (never re-queued automatically). Returns the affected ids.
   */
  expireLeases(nowIso: string): string[] {
    const lapsed = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.state, "running"), lte(tasks.leaseExpiresAt, nowIso)))
      .all();
    for (const { id } of lapsed) {
      this.setTaskState(id, "needs_reconciliation", {
        reason: "lease expired: worker stopped heartbeating",
      });
    }
    return lapsed.map((r) => r.id);
  }

  registerWorktree(w: { taskId: string; path: string; branch: string; baseSha: string }): string {
    const id = newId("wt");
    this.db
      .insert(worktrees)
      .values({ id, ...w, createdAt: now() })
      .run();
    return id;
  }

  markWorktreeRemoved(taskId: string): void {
    this.db
      .update(worktrees)
      .set({ state: "removed", removedAt: now() })
      .where(and(eq(worktrees.taskId, taskId), eq(worktrees.state, "active")))
      .run();
  }

  getWorktree(taskId: string) {
    return this.db.select().from(worktrees).where(eq(worktrees.taskId, taskId)).get();
  }

  listActiveWorktrees() {
    return this.db
      .select()
      .from(worktrees)
      .where(eq(worktrees.state, "active"))
      .orderBy(asc(worktrees.createdAt))
      .all();
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
    opts: { reason?: string; incrementAttempt?: boolean; leaseExpiresAt?: string } = {},
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
          // a lease only exists while running; leaving `running` always clears it
          leaseExpiresAt: state === "running" ? (opts.leaseExpiresAt ?? null) : null,
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

  /**
   * Appends a message AND its pending delivery to `toAgent` in ONE transaction: a committed message
   * always has a delivery row, and a failed insert leaves neither.
   */
  appendMessageWithOutbox(input: Omit<AgentMessage, "sequence">, sequence: number): void {
    const msg = AgentMessage.parse({ ...input, sequence });
    this.db.transaction((tx) => {
      tx.insert(messages)
        .values({
          id: msg.id,
          taskId: msg.taskId,
          sequence: msg.sequence,
          messageType: msg.type,
          payloadJson: JSON.stringify(msg),
          createdAt: msg.createdAt,
        })
        .run();
      tx.insert(outbox)
        .values({
          id: newId("obx"),
          messageId: msg.id,
          recipient: msg.toAgent,
          nextAttemptAt: msg.createdAt,
          createdAt: msg.createdAt,
        })
        .run();
    });
  }

  /** Pending deliveries whose retry time has come, oldest first. Does not lock: one router per DB. */
  claimDueDeliveries(nowIso: string, limit: number) {
    return this.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.state, "pending"), lte(outbox.nextAttemptAt, nowIso)))
      .orderBy(asc(outbox.nextAttemptAt), asc(outbox.createdAt))
      .limit(limit)
      .all();
  }

  markDelivered(deliveryId: string, at: string): void {
    this.db
      .update(outbox)
      .set({ state: "delivered", deliveredAt: at, lastError: null })
      .where(eq(outbox.id, deliveryId))
      .run();
  }

  /** Counts the failed attempt; returns "dead" (dead-letter) once `maxAttempts` is reached, else "pending". */
  recordDeliveryFailure(
    deliveryId: string,
    error: string,
    nextAttemptAt: string,
    maxAttempts: number,
  ): "pending" | "dead" {
    return this.db.transaction((tx) => {
      const row = tx.select().from(outbox).where(eq(outbox.id, deliveryId)).get();
      if (!row) throw new Error(`unknown delivery ${deliveryId}`);
      const attempts = row.attempts + 1;
      const state = attempts >= maxAttempts ? "dead" : "pending";
      tx.update(outbox)
        .set({ attempts, state, lastError: error, nextAttemptAt })
        .where(eq(outbox.id, deliveryId))
        .run();
      return state;
    });
  }

  listDeadLetters() {
    return this.db.select().from(outbox).where(eq(outbox.state, "dead")).all();
  }

  hasInbound(recipient: string, messageId: string): boolean {
    return (
      this.db
        .select()
        .from(inbox)
        .where(and(eq(inbox.recipient, recipient), eq(inbox.messageId, messageId)))
        .get() !== undefined
    );
  }

  getMessage(messageId: string): AgentMessage | undefined {
    const r = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    return r ? AgentMessage.parse(JSON.parse(r.payloadJson)) : undefined;
  }

  /** Records receipt; returns false when this (recipient, message) was already accepted (duplicate). */
  acceptInbound(recipient: string, messageId: string, at: string): boolean {
    return (
      this.db
        .insert(inbox)
        .values({ recipient, messageId, receivedAt: at })
        .onConflictDoNothing()
        .run().changes === 1
    );
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
