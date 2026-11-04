CREATE TABLE `approval_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`scope` text NOT NULL,
	`target` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approval_grants_scope_check" CHECK("approval_grants"."scope" IN ('task','project','path','command'))
);
--> statement-breakpoint
CREATE INDEX `idx_approval_grants_approval` ON `approval_grants` (`approval_id`);--> statement-breakpoint
ALTER TABLE `approvals` ADD `decided_by` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `decision_scope` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `decision_note` text;