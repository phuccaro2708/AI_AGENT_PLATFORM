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
  approvals,
  contextEntries,
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

  setWorkflowState(
    workflowId: string,
    state: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled",
  ): void {
    this.db.update(workflows).set({ state }).where(eq(workflows.id, workflowId)).run();
  }

  getWorkflowState(workflowId: string): string | undefined {
    return this.db
      .select({ s: workflows.state })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .get()?.s;
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
        .orderBy(desc(tasks.priority), asc(tasks.createdAt), sql`${tasks}.rowid`)
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
      .orderBy(asc(tasks.createdAt), sql`${tasks}.rowid`)
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

  addContextEntry(e: {
    workflowId: string;
    kind: "goal" | "plan" | "decision" | "artifact" | "report";
    source: "user" | "verified" | "agent-reported";
    content: string;
    authorTaskId?: string;
    path?: string;
    sha256?: string | null;
  }): string {
    const id = newId("ctx");
    this.db
      .insert(contextEntries)
      .values({
        id,
        workflowId: e.workflowId,
        kind: e.kind,
        source: e.source,
        content: e.content,
        authorTaskId: e.authorTaskId ?? null,
        path: e.path ?? null,
        sha256: e.sha256 ?? null,
        createdAt: now(),
      })
      .run();
    return id;
  }

  /** Every entry of a workflow, oldest first. Visibility filtering is the caller's job (see ContextBoard). */
  listContextEntries(workflowId: string) {
    return (
      this.db
        .select()
        .from(contextEntries)
        .where(eq(contextEntries.workflowId, workflowId))
        // rowid is insertion order: entries within one millisecond must not reorder by random id
        .orderBy(asc(contextEntries.createdAt), sql`rowid`)
        .all()
    );
  }

  /**
   * Opens an approval and parks the task in `waiting_approval` in ONE transaction (the task must be
   * `running`). The request is stored as given and must be treated as untrusted data.
   */
  createApproval(a: {
    taskId: string;
    request: unknown;
    expiresAt?: string;
    nowIso?: string;
  }): string {
    const at = a.nowIso ?? now();
    const id = newId("apr");
    this.db.transaction((tx) => {
      this.setTaskState(a.taskId, "waiting_approval", { reason: `approval ${id}` });
      tx.insert(approvals)
        .values({
          id,
          taskId: a.taskId,
          requestJson: JSON.stringify(a.request),
          createdAt: at,
          expiresAt: a.expiresAt ?? null,
        })
        .run();
      tx.insert(events)
        .values({
          id: newId("evt"),
          aggregateId: id,
          eventType: "approval.requested",
          payloadJson: JSON.stringify({ taskId: a.taskId, expiresAt: a.expiresAt ?? null }),
          createdAt: at,
        })
        .run();
    });
    return id;
  }

  getApproval(id: string) {
    return this.db.select().from(approvals).where(eq(approvals.id, id)).get();
  }

  listPendingApprovals(taskId?: string) {
    return this.db
      .select()
      .from(approvals)
      .where(
        taskId
          ? and(eq(approvals.state, "pending"), eq(approvals.taskId, taskId))
          : eq(approvals.state, "pending"),
      )
      .orderBy(asc(approvals.createdAt), sql`rowid`)
      .all();
  }

  /** Pending approvals whose deadline has passed. */
  listDueApprovals(nowIso: string): string[] {
    return this.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.state, "pending"), lte(approvals.expiresAt, nowIso)))
      .all()
      .map((r) => r.id);
  }

  /**
   * Decides a pending approval exactly once (compare-and-set). An `approved` answer that arrives
   * after the deadline is recorded as `expired`: a late "yes" never authorises anything. When the
   * task is still `waiting_approval` it returns to `running` (with a fresh lease) so the agent can
   * continue — on `denied`/`expired` too: the agent is told no, it is not killed.
   * Returns the final state, or undefined when the approval was unknown or already decided.
   */
  resolveApproval(
    id: string,
    decision: "approved" | "denied" | "expired",
    o: { by: string; reason?: string; nowIso: string; leaseMs: number },
  ): "approved" | "denied" | "expired" | undefined {
    return this.db.transaction((tx) => {
      const row = tx.select().from(approvals).where(eq(approvals.id, id)).get();
      if (!row || row.state !== "pending") return undefined;
      const late = row.expiresAt !== null && row.expiresAt <= o.nowIso;
      const final = decision === "approved" && late ? "expired" : decision;
      const res = tx
        .update(approvals)
        .set({
          state: final,
          resolvedAt: o.nowIso,
          resolvedBy: final === decision ? o.by : "system:expired",
          reason: o.reason ?? null,
        })
        .where(and(eq(approvals.id, id), eq(approvals.state, "pending")))
        .run();
      if (res.changes !== 1) return undefined;
      if (this.getTaskState(row.taskId) === "waiting_approval") {
        this.setTaskState(row.taskId, "running", {
          leaseExpiresAt: new Date(Date.parse(o.nowIso) + o.leaseMs).toISOString(),
        });
      }
      tx.insert(events)
        .values({
          id: newId("evt"),
          aggregateId: id,
          eventType: "approval.resolved",
          payloadJson: JSON.stringify({
            state: final,
            requested: decision,
            by: o.by,
            reason: o.reason ?? null,
          }),
          createdAt: o.nowIso,
        })
        .run();
      return final;
    });
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

  getTask(taskId: string) {
    return this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
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
      // nobody is waiting for these answers any more; an old "yes" must not resurrect them
      this.db
        .update(approvals)
        .set({ state: "expired", resolvedAt: now(), resolvedBy: "system:restart" })
        .where(and(eq(approvals.taskId, id), eq(approvals.state, "pending")))
        .run();
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

  /** Next free per-task sequence (0 for a task without messages). */
  nextMessageSequence(taskId: string): number {
    const r = this.db
      .select({ m: sql<number | null>`max(${messages.sequence})` })
      .from(messages)
      .where(eq(messages.taskId, taskId))
      .get();
    return r?.m == null ? 0 : r.m + 1;
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
      .orderBy(asc(events.createdAt), sql`rowid`)
      .all();
  }
}
