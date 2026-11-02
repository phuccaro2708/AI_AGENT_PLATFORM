CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`request_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	`resolved_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_state_check" CHECK("approvals"."state" IN ('pending','approved','denied','expired'))
);
--> statement-breakpoint
CREATE INDEX `idx_approvals_task_state` ON `approvals` (`task_id`,`state`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "artifacts_sha256_check" CHECK(length("artifacts"."sha256") = 64)
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_task` ON `artifacts` (`task_id`);--> statement-breakpoint
CREATE TABLE `execution_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`pid` integer,
	`exit_code` integer,
	`signal` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_execution_runs_task` ON `execution_runs` (`task_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`native_session_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_project_agent` ON `sessions` (`project_id`,`agent_id`);