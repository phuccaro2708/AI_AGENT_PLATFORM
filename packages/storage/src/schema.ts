import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check(
      "workflows_state_check",
      sql`${t.state} IN ('pending','running','paused','completed','failed','cancelled')`,
    ),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    agentId: text("agent_id"),
    state: text("state").notNull(),
    priority: integer("priority").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    leaseExpiresAt: text("lease_expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "tasks_state_check",
      sql`${t.state} IN ('queued','running','waiting_approval','needs_reconciliation','completed','failed','cancelled')`,
    ),
    index("idx_tasks_queue").on(t.state, sql`${t.priority} DESC`, t.createdAt),
  ],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    dependencyId: text("dependency_id")
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependencyId] }),
    check("task_dependencies_self_check", sql`${t.taskId} != ${t.dependencyId}`),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    sequence: integer("sequence").notNull(),
    messageType: text("message_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("messages_task_sequence_unique").on(t.taskId, t.sequence),
    index("idx_messages_task").on(t.taskId, t.sequence),
  ],
);

/** Append-only audit / event-sourcing log. */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_events_aggregate").on(t.aggregateId, t.createdAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Maps our task/agent to the provider CLI's native session (resume is only used if a probe confirms it). */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    agentId: text("agent_id").notNull(),
    nativeSessionId: text("native_session_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_sessions_project_agent").on(t.projectId, t.agentId)],
);

/** One row per process launch for a task attempt. */
export const executionRuns = sqliteTable(
  "execution_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    sessionId: text("session_id").references(() => sessions.id),
    attempt: integer("attempt").notNull().default(0),
    pid: integer("pid"),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => [index("idx_execution_runs_task").on(t.taskId, t.startedAt)],
);

/** Files produced by a task; `sha256` is hex of the content at registration time. */
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_artifacts_task").on(t.taskId),
    check("artifacts_sha256_check", sql`length(${t.sha256}) = 64`),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    state: text("state").notNull().default("pending"),
    requestJson: text("request_json").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    index("idx_approvals_task_state").on(t.taskId, t.state),
    check("approvals_state_check", sql`${t.state} IN ('pending','approved','denied','expired')`),
  ],
);

/** Latest probe result per provider CLI (one row per provider; B3). Capabilities are what `--help` showed, not guarantees. */
export const agents = sqliteTable(
  "agents",
  {
    provider: text("provider").primaryKey(),
    status: text("status").notNull(),
    executablePath: text("executable_path"),
    version: text("version"),
    capabilitiesJson: text("capabilities_json").notNull(),
    errorJson: text("error_json"),
    probedAt: text("probed_at").notNull(),
  },
  (t) => [
    check(
      "agents_status_check",
      sql`${t.status} IN ('ok','not_installed','shim_unsupported','spawn_error','timeout','exit_nonzero','version_unparsable')`,
    ),
  ],
);

/**
 * Delivery ledger: one row per (message, recipient). Written in the SAME transaction as the message,
 * so a committed message always has a pending delivery. Payload lives only in `messages`.
 */
export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    recipient: text("recipient").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
  },
  (t) => [
    unique("outbox_message_recipient_unique").on(t.messageId, t.recipient),
    index("idx_outbox_due").on(t.state, t.nextAttemptAt),
    check("outbox_state_check", sql`${t.state} IN ('pending','delivered','dead')`),
  ],
);

/** Receiver-side dedupe: a (recipient, message) pair is processed at most once. */
export const inbox = sqliteTable(
  "inbox",
  {
    recipient: text("recipient").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    receivedAt: text("received_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.recipient, t.messageId] })],
);

/** Registry of per-task git worktrees (branch isolation, not a sandbox). One active row per task. */
export const worktrees = sqliteTable(
  "worktrees",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .unique()
      .references(() => tasks.id),
    path: text("path").notNull(),
    branch: text("branch").notNull(),
    baseSha: text("base_sha").notNull(),
    state: text("state").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    removedAt: text("removed_at"),
  },
  (t) => [check("worktrees_state_check", sql`${t.state} IN ('active','removed')`)],
);

/**
 * Shared context board (Phase 2): what agents in one workflow may be told about each other's work.
 * `source` says who vouches for an entry; only the engine writes `verified` (it measured it itself).
 * Artifact entries carry the path and the sha256 of its content (null = the file was deleted).
 */
export const contextEntries = sqliteTable(
  "context_entries",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    authorTaskId: text("author_task_id").references(() => tasks.id),
    content: text("content").notNull(),
    path: text("path"),
    sha256: text("sha256"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_context_workflow").on(t.workflowId, t.createdAt),
    check("context_kind_check", sql`${t.kind} IN ('goal','plan','decision','artifact','report')`),
    check("context_source_check", sql`${t.source} IN ('user','verified','agent-reported')`),
    check("context_artifact_check", sql`${t.kind} != 'artifact' OR ${t.path} IS NOT NULL`),
    check("context_sha_check", sql`${t.sha256} IS NULL OR length(${t.sha256}) = 64`),
  ],
);
