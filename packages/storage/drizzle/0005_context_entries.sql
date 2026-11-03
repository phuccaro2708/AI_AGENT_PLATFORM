CREATE TABLE `context_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`author_task_id` text,
	`content` text NOT NULL,
	`path` text,
	`sha256` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "context_kind_check" CHECK("context_entries"."kind" IN ('goal','plan','decision','artifact','report')),
	CONSTRAINT "context_source_check" CHECK("context_entries"."source" IN ('user','verified','agent-reported')),
	CONSTRAINT "context_artifact_check" CHECK("context_entries"."kind" != 'artifact' OR "context_entries"."path" IS NOT NULL),
	CONSTRAINT "context_sha_check" CHECK("context_entries"."sha256" IS NULL OR length("context_entries"."sha256") = 64)
);
--> statement-breakpoint
CREATE INDEX `idx_context_workflow` ON `context_entries` (`workflow_id`,`created_at`);