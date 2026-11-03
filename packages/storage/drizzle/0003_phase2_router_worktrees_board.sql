CREATE TABLE `context_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`path` text,
	`sha256` text,
	`source` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "context_items_kind_check" CHECK("context_items"."kind" IN ('goal','plan','decision','artifact')),
	CONSTRAINT "context_items_source_check" CHECK("context_items"."source" IN ('verified','agent_reported')),
	CONSTRAINT "context_items_sha256_check" CHECK("context_items"."sha256" IS NULL OR length("context_items"."sha256") = 64)
);
--> statement-breakpoint
CREATE INDEX `idx_context_items_workflow` ON `context_items` (`workflow_id`,`kind`);--> statement-breakpoint
CREATE TABLE `inbox` (
	`message_id` text NOT NULL,
	`consumer` text NOT NULL,
	`received_at` text NOT NULL,
	`acked_at` text,
	PRIMARY KEY(`message_id`, `consumer`)
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`task_id` text NOT NULL,
	`to_agent` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_status_check" CHECK("outbox"."status" IN ('pending','delivered','dead_letter'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_message_id_unique` ON `outbox` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_due` ON `outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `workflow_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`permissions` text NOT NULL,
	`allowed_agents_json` text NOT NULL,
	`agent_id` text,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_roles_permissions_check" CHECK("workflow_roles"."permissions" IN ('read-only','workspace-write'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_roles_name_unique` ON `workflow_roles` (`workflow_id`,`name`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`task_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_ref` text NOT NULL,
	`state` text DEFAULT 'creating' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "worktrees_state_check" CHECK("worktrees"."state" IN ('creating','active','removing','removed','orphaned'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_task_id_unique` ON `worktrees` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_unique` ON `worktrees` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_branch_unique` ON `worktrees` (`branch`);--> statement-breakpoint
CREATE INDEX `idx_worktrees_workflow` ON `worktrees` (`workflow_id`);