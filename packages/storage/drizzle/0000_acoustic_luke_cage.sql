CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`aggregate_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_aggregate` ON `events` (`aggregate_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`message_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_task` ON `messages` (`task_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_task_sequence_unique` ON `messages` (`task_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_root_path_unique` ON `projects` (`root_path`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`dependency_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `dependency_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dependency_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_dependencies_self_check" CHECK("task_dependencies"."task_id" != "task_dependencies"."dependency_id")
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`agent_id` text,
	`state` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_state_check" CHECK("tasks"."state" IN ('queued','running','waiting_approval','needs_reconciliation','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_queue` ON `tasks` (`state`,"priority" DESC,`created_at`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflows_state_check" CHECK("workflows"."state" IN ('pending','running','paused','completed','failed','cancelled'))
);
