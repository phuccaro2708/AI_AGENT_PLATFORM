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
