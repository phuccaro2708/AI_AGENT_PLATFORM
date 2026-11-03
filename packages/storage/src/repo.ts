import { and, asc, eq, gt, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
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
  artifacts,
  contextItems,
  events,
  executionRuns,
  inbox,
  messages,
  outbox,
  projects,
  taskDependencies,
  tasks,
  workflowRoles,
  workflows,
  worktrees,
} from "./schema.js";

const now = () => new Date().toISOString();

/** What Repo needs from a database: satisfied by `StudioDb` and by a drizzle transaction handle. */
export type RepoDb = Pick<StudioDb, "select" | "insert" | "update" | "delete" | "transaction">;

export type OutboxStatus = "pending" | "delivered" | "dead_letter";
export type WorktreeState = "creating" | "active" | "removing" | "removed" | "orphaned";
export type RolePermissions = "read-only" | "workspace-write";
export type ContextKind = "goal" | "plan" | "decision" | "artifact";
export type ContextSource = "verified" | "agent_reported";
export type ApprovalState = "pending" | "approved" | "denied" | "expired";

/** Raised when adding a dependency would make the task graph cyclic. */
export class DependencyCycleError extends Error {
  constructor(
    readonly taskId: string,
    readonly dependencyId: string,
  ) {
    super(`Dependency ${taskId} -> ${dependencyId} would create a cycle`);
    this.name = "DependencyCycleError";
  }
}

/** Thin repository layer. State change + event are written in ONE transaction. */
export class Repo {
  constructor(private readonly db: RepoDb) {}

  /**
   * Runs `fn` in one transaction against a Repo bound to it; any throw rolls everything back.
   * Synchronous on purpose (better-sqlite3): never hold a transaction across an `await`.
   * Nested Repo calls (e.g. `setTaskState`) join this transaction as savepoints.
   */
  tx<T>(fn: (repo: Repo) => T): T {
    return this.db.transaction((tx) => fn(new Repo(tx as unknown as RepoDb)));
  }

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

  /**
   * Appends a message with the next sequence for its task (`MAX(sequence)+1`, computed inside the
   * same transaction as the insert). Unlike a caller-held counter this survives requeue/restart.
   */
  appendMessageAuto(input: Omit<AgentMessage, "sequence">): AgentMessage {
    return this.tx((r) => {
      const row = r.db
        .select({ m: sql<number | null>`max(${messages.sequence})` })
        .from(messages)
        .where(eq(messages.taskId, input.taskId))
        .get();
      const sequence = (row?.m ?? -1) + 1;
      r.appendMessage(input, sequence);
      return AgentMessage.parse({ ...input, sequence });
    });
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

  // ---- task dependencies (DAG) ----

  /** `taskId` waits for `dependencyId`. Idempotent; throws {@link DependencyCycleError} on a cycle. */
  addDependency(taskId: string, dependencyId: string): void {
    this.tx((r) => {
      if (taskId === dependencyId || r.dependsOnTransitively(dependencyId, taskId)) {
        throw new DependencyCycleError(taskId, dependencyId);
      }
      r.db.insert(taskDependencies).values({ taskId, dependencyId }).onConflictDoNothing().run();
    });
  }

  listDependencies(taskId: string): string[] {
    return this.db
      .select({ d: taskDependencies.dependencyId })
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .all()
      .map((r) => r.d);
  }

  /** True when `from` reaches `target` by following "waits for" edges. */
  private dependsOnTransitively(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...this.listDependencies(id));
    }
    return false;
  }

  // ---- router outbox / inbox ----

  /** Returns false when `messageId` was already enqueued (dedupe). Call inside {@link tx} with the state change. */
  enqueueOutbox(input: {
    messageId: string;
    taskId: string;
    toAgent: string;
    payload: unknown;
    nextAttemptAt: string;
  }): boolean {
    const res = this.db
      .insert(outbox)
      .values({
        id: newId("obx"),
        messageId: input.messageId,
        taskId: input.taskId,
        toAgent: input.toAgent,
        payloadJson: JSON.stringify(input.payload),
        nextAttemptAt: input.nextAttemptAt,
        createdAt: now(),
      })
      .onConflictDoNothing({ target: outbox.messageId })
      .run();
    return res.changes === 1;
  }

  /** Pending rows whose retry time has come, oldest due first. */
  listDueOutbox(nowIso: string, limit: number) {
    return this.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.status, "pending"), lte(outbox.nextAttemptAt, nowIso)))
      .orderBy(asc(outbox.nextAttemptAt), asc(outbox.createdAt))
      .limit(limit)
      .all();
  }

  getOutbox(messageId: string) {
    return this.db.select().from(outbox).where(eq(outbox.messageId, messageId)).get();
  }

  markOutboxDelivered(id: string): void {
    const res = this.db
      .update(outbox)
      .set({ status: "delivered", deliveredAt: now() })
      .where(and(eq(outbox.id, id), eq(outbox.status, "pending")))
      .run();
    if (res.changes !== 1) throw new Error(`Outbox row is not pending: ${id}`);
  }

  /** Counts a failed attempt; schedules the next one, or dead-letters at `maxAttempts`. */
  markOutboxFailed(
    id: string,
    error: string,
    nextAttemptAt: string,
    maxAttempts: number,
  ): OutboxStatus {
    return this.tx((r) => {
      const row = r.db.select().from(outbox).where(eq(outbox.id, id)).get();
      if (!row || row.status !== "pending") throw new Error(`Outbox row is not pending: ${id}`);
      const attempts = row.attempts + 1;
      const status: OutboxStatus = attempts >= maxAttempts ? "dead_letter" : "pending";
      r.db
        .update(outbox)
        .set({ attempts, status, lastError: error, nextAttemptAt })
        .where(eq(outbox.id, id))
        .run();
      return status;
    });
  }

  /** First delivery of (message, consumer) returns true; a duplicate returns false and must be skipped. */
  receiveInbox(messageId: string, consumer: string): boolean {
    const res = this.db
      .insert(inbox)
      .values({ messageId, consumer, receivedAt: now() })
      .onConflictDoNothing()
      .run();
    return res.changes === 1;
  }

  /** True when this call recorded the ack (false if unknown or already acked). */
  ackInbox(messageId: string, consumer: string): boolean {
    const res = this.db
      .update(inbox)
      .set({ ackedAt: now() })
      .where(
        and(
          eq(inbox.messageId, messageId),
          eq(inbox.consumer, consumer),
          sql`${inbox.ackedAt} IS NULL`,
        ),
      )
      .run();
    return res.changes === 1;
  }

  // ---- worktrees ----

  createWorktree(input: {
    workflowId: string;
    taskId: string;
    path: string;
    branch: string;
    baseRef: string;
  }): string {
    const id = newId("wt");
    const ts = now();
    this.db
      .insert(worktrees)
      .values({ id, ...input, state: "creating", createdAt: ts, updatedAt: ts })
      .run();
    return id;
  }

  setWorktreeState(id: string, state: WorktreeState): void {
    const res = this.db
      .update(worktrees)
      .set({ state, updatedAt: now() })
      .where(eq(worktrees.id, id))
      .run();
    if (res.changes !== 1) throw new Error(`Unknown worktree: ${id}`);
  }

  getWorktreeForTask(taskId: string) {
    return this.db.select().from(worktrees).where(eq(worktrees.taskId, taskId)).get();
  }

  listWorktrees(workflowId: string) {
    return this.db
      .select()
      .from(worktrees)
      .where(eq(worktrees.workflowId, workflowId))
      .orderBy(asc(worktrees.createdAt))
      .all();
  }

  // ---- roles ----

  /** Creates or updates a role definition; an existing agent assignment is kept. */
  upsertRole(input: {
    workflowId: string;
    name: string;
    instructions: string;
    permissions: RolePermissions;
    allowedAgents: string[];
  }): void {
    const values = {
      instructions: input.instructions,
      permissions: input.permissions,
      allowedAgentsJson: JSON.stringify(input.allowedAgents),
    };
    this.db
      .insert(workflowRoles)
      .values({ id: newId("role"), workflowId: input.workflowId, name: input.name, ...values })
      .onConflictDoUpdate({ target: [workflowRoles.workflowId, workflowRoles.name], set: values })
      .run();
  }

  /** Assigns the run's agent to a role; the agent must be in the role's allowed list. */
  assignRoleAgent(workflowId: string, name: string, agentId: string): void {
    this.tx((r) => {
      const role = r.db
        .select()
        .from(workflowRoles)
        .where(and(eq(workflowRoles.workflowId, workflowId), eq(workflowRoles.name, name)))
        .get();
      if (!role) throw new Error(`Unknown role: ${name}`);
      if (!(JSON.parse(role.allowedAgentsJson) as string[]).includes(agentId)) {
        throw new Error(`Agent ${agentId} is not allowed for role ${name}`);
      }
      r.db.update(workflowRoles).set({ agentId }).where(eq(workflowRoles.id, role.id)).run();
    });
  }

  listRoles(workflowId: string) {
    return this.db
      .select()
      .from(workflowRoles)
      .where(eq(workflowRoles.workflowId, workflowId))
      .orderBy(asc(workflowRoles.name))
      .all()
      .map((r) => ({
        id: r.id,
        workflowId: r.workflowId,
        name: r.name,
        instructions: r.instructions,
        permissions: r.permissions as RolePermissions,
        allowedAgents: JSON.parse(r.allowedAgentsJson) as string[],
        agentId: r.agentId ?? undefined,
      }));
  }

  // ---- shared context board ----

  addContextItem(input: {
    workflowId: string;
    kind: ContextKind;
    content: string;
    source: ContextSource;
    createdBy: string;
    path?: string;
    sha256?: string;
  }): string {
    const id = newId("ctx");
    this.db
      .insert(contextItems)
      .values({
        id,
        workflowId: input.workflowId,
        kind: input.kind,
        content: input.content,
        path: input.path ?? null,
        sha256: input.sha256 ?? null,
        source: input.source,
        createdBy: input.createdBy,
        createdAt: now(),
      })
      .run();
    return id;
  }

  listContextItems(workflowId: string, kinds?: ContextKind[]) {
    const where =
      kinds === undefined
        ? eq(contextItems.workflowId, workflowId)
        : and(eq(contextItems.workflowId, workflowId), inArray(contextItems.kind, kinds));
    return this.db
      .select()
      .from(contextItems)
      .where(where)
      .orderBy(asc(contextItems.createdAt))
      .all();
  }

  // ---- artifacts ----

  registerArtifact(taskId: string, path: string, sha256: string): string {
    const id = newId("art");
    this.db.insert(artifacts).values({ id, taskId, path, sha256, createdAt: now() }).run();
    return id;
  }

  listArtifacts(taskId: string) {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, taskId))
      .orderBy(asc(artifacts.createdAt))
      .all();
  }

  // ---- approvals ----

  createApproval(taskId: string, request: unknown, expiresAt?: string): string {
    const id = newId("apr");
    this.db
      .insert(approvals)
      .values({
        id,
        taskId,
        requestJson: JSON.stringify(request),
        createdAt: now(),
        expiresAt: expiresAt ?? null,
      })
      .run();
    return id;
  }

  /** Only a pending approval can be resolved, exactly once. */
  resolveApproval(id: string, decision: "approved" | "denied"): void {
    const res = this.db
      .update(approvals)
      .set({ state: decision, resolvedAt: now() })
      .where(and(eq(approvals.id, id), eq(approvals.state, "pending")))
      .run();
    if (res.changes !== 1) throw new Error(`Approval is not pending: ${id}`);
  }

  /** Marks pending approvals whose `expires_at` is before `nowIso` as expired; returns their ids. */
  expireApprovals(nowIso: string): string[] {
    return this.tx((r) => {
      const due = r.db
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.state, "pending"),
            isNotNull(approvals.expiresAt),
            lt(approvals.expiresAt, nowIso),
          ),
        )
        .all()
        .map((a) => a.id);
      if (due.length > 0) {
        r.db
          .update(approvals)
          .set({ state: "expired", resolvedAt: nowIso })
          .where(inArray(approvals.id, due))
          .run();
      }
      return due;
    });
  }

  listApprovals(state?: ApprovalState) {
    const q = this.db.select().from(approvals);
    return (state === undefined ? q : q.where(eq(approvals.state, state)))
      .orderBy(asc(approvals.createdAt))
      .all();
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
