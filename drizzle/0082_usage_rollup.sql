-- Usage: the agent's spend on this computer, for the Usage page every surface
-- shows (app, CLI, VS Code, ACP).
--
-- `usage_rollup` replaces `usage_stats` for new writes. It adds what the Usage
-- page filters and prices by: the editor, the source (a chat, an automation,
-- sub-agents, compaction, the app's other calls), the cache split, and a BYOK
-- cost estimate. A new table rather than a rebuilt one: an older build upserts
-- `usage_stats` on its five-column key, and SQLite refuses an ON CONFLICT that
-- matches no unique index, so changing that key would break every older reader
-- still sharing this file. `usage_stats` stays as it is; the reader adds both,
-- and nothing is copied, so nothing is counted twice.
--
-- `usage_auto_picks`: which model Atlarix Auto answered with, per reply, from
-- the reply's own headers. Nothing else on this computer records it.
--
-- Additive only (two new tables): an older reader ignores them, so min_reader
-- stays where it is.
CREATE TABLE `usage_rollup` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`surface` text NOT NULL,
	`editor` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`mode` text NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`deep_turns` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`est_cost_micros` integer DEFAULT 0 NOT NULL,
	`priced_turns` integer DEFAULT 0 NOT NULL,
	`unpriced_turns` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_rollup_bucket_unique` ON `usage_rollup` (`day`,`surface`,`editor`,`source`,`provider`,`model_id`,`mode`);
--> statement-breakpoint
CREATE TABLE `usage_auto_picks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`surface` text NOT NULL,
	`billing` text NOT NULL,
	`tier` text DEFAULT '' NOT NULL,
	`served_model` text NOT NULL,
	`steps` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_auto_picks_bucket_unique` ON `usage_auto_picks` (`day`,`surface`,`billing`,`tier`,`served_model`);
