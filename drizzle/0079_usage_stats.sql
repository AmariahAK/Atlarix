-- Your activity: the agent's finished turns on this computer, for the stats page
-- (tokens, models, modes, streaks, most-used skills and MCP servers).
--
-- Daily ROLLUPS like `edit_stats`: bounded for the life of the install with no
-- pruning job, no prompt text, no file paths. The unique buckets make every write
-- an UPSERT, so two surfaces finishing turns at once can't lose a count.
--
-- Additive only (two new tables): an older reader ignores them, so min_reader
-- stays where it is.
CREATE TABLE `usage_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`surface` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`mode` text NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`deep_turns` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_stats_bucket_unique` ON `usage_stats` (`day`,`surface`,`provider`,`model_id`,`mode`);
--> statement-breakpoint
CREATE TABLE `usage_tool_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_tool_stats_bucket_unique` ON `usage_tool_stats` (`day`,`kind`,`name`);
