CREATE TABLE `agents` (
	`provider` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`executable_path` text,
	`version` text,
	`capabilities_json` text NOT NULL,
	`error_json` text,
	`probed_at` text NOT NULL,
	CONSTRAINT "agents_status_check" CHECK("agents"."status" IN ('ok','not_installed','shim_unsupported','spawn_error','timeout','exit_nonzero','version_unparsable'))
);
