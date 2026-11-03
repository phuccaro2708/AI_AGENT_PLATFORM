CREATE TABLE `inbox` (
	`recipient` text NOT NULL,
	`message_id` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`recipient`, `message_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`recipient` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_state_check" CHECK("outbox"."state" IN ('pending','delivered','dead'))
);
--> statement-breakpoint
CREATE INDEX `idx_outbox_due` ON `outbox` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_message_recipient_unique` ON `outbox` (`message_id`,`recipient`);