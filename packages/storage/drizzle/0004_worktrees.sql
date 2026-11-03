CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "worktrees_state_check" CHECK("worktrees"."state" IN ('active','removed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_task_id_unique` ON `worktrees` (`task_id`);