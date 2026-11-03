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
 * User-chosen way to launch a CLI agent (Phase 7B). A row exists only after a successful probe, so
 * what is stored is what was verified. Holds NO secrets: `env_json` is for plain settings; secret
 * values live in the OS credential store.
 */
export const agentSettings = sqliteTable("agent_settings", {
  provider: text("provider").primaryKey(),
  command: text("command").notNull(),
  argsJson: text("args_json").notNull(),
  envJson: text("env_json").notNull(),
  verifiedAt: text("verified_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Router outbox: written in the SAME transaction as the state change that produced the message, then
 * delivered at-least-once. `message_id` is UNIQUE so re-enqueueing the same message is a no-op (dedupe).
 */
export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull().unique(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    toAgent: text("to_agent").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
  },
  (t) => [
    index("idx_outbox_due").on(t.status, t.nextAttemptAt),
    check("outbox_status_check", sql`${t.status} IN ('pending','delivered','dead_letter')`),
  ],
);

/** Delivery ledger on the receiving side: one row per (message, consumer) makes handlers idempotent. */
export const inbox = sqliteTable(
  "inbox",
  {
    messageId: text("message_id").notNull(),
    consumer: text("consumer").notNull(),
    receivedAt: text("received_at").notNull(),
    ackedAt: text("acked_at"),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.consumer] })],
);

/** One git worktree per task. A worktree is NOT a security sandbox (CLAUDE.md principle 5). */
export const worktrees = sqliteTable(
  "worktrees",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    taskId: text("task_id")
      .notNull()
      .unique()
      .references(() => tasks.id),
    path: text("path").notNull().unique(),
    branch: text("branch").notNull().unique(),
    baseRef: text("base_ref").notNull(),
    state: text("state").notNull().default("creating"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_worktrees_workflow").on(t.workflowId),
    check(
      "worktrees_state_check",
      sql`${t.state} IN ('creating','active','removing','removed','orphaned')`,
    ),
  ],
);

/** A role inside one workflow run; `agent_id` is the run's assignment, never hard-coded by agent name. */
export const workflowRoles = sqliteTable(
  "workflow_roles",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    name: text("name").notNull(),
    instructions: text("instructions").notNull(),
    permissions: text("permissions").notNull(),
    allowedAgentsJson: text("allowed_agents_json").notNull(),
    /** Context board kinds this role may see. Least privilege by default: the goal only. */
    visibleKindsJson: text("visible_kinds_json").notNull().default('["goal"]'),
    agentId: text("agent_id"),
  },
  (t) => [
    unique("workflow_roles_name_unique").on(t.workflowId, t.name),
    check(
      "workflow_roles_permissions_check",
      sql`${t.permissions} IN ('read-only','workspace-write')`,
    ),
  ],
);

/** Shared context board entry (goal / plan / decision / artifact) with provenance. */
export const contextItems = sqliteTable(
  "context_items",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    path: text("path"),
    sha256: text("sha256"),
    source: text("source").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_context_items_workflow").on(t.workflowId, t.kind),
    check("context_items_kind_check", sql`${t.kind} IN ('goal','plan','decision','artifact')`),
    check("context_items_source_check", sql`${t.source} IN ('verified','agent_reported')`),
    check("context_items_sha256_check", sql`${t.sha256} IS NULL OR length(${t.sha256}) = 64`),
  ],
);
