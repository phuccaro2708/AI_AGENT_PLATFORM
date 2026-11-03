CREATE TABLE `agent_settings` (
	`provider` text PRIMARY KEY NOT NULL,
	`command` text NOT NULL,
	`args_json` text NOT NULL,
	`env_json` text NOT NULL,
	`verified_at` text NOT NULL,
	`updated_at` text NOT NULL
);
