-- How much the agent has actually written, per workspace and per model.
--
-- Nothing recorded this. `workspace_modifications` and `daily_logs` look like they
-- might, but both are dyad-era: the current write path has never inserted into
-- either, and the only code left touching `workspace_modifications` is the cleanup
-- job that summarises rows nobody creates. So this is a new table rather than a
-- revival — reviving one would have meant inheriting a shape built for a different
-- question.
--
-- A daily ROLLUP, not a row per edit. The counts are gross by decision (reverting a
-- turn does not subtract, the same way "lines written" works in every editor that
-- shows it), so the table only ever accumulates and a sum over these rows answers
-- every question a per-edit history would. In exchange it stays bounded for the life
-- of the install with no pruning job, and it never puts a file path on disk.
--
-- The bucket is (workspace, day, provider, model) and the unique index is what makes
-- the write an UPSERT rather than a read-modify-write, so concurrent edits in two
-- windows cannot lose a count between them.
--
-- `provider` is kept beside `model_id` because it is the only thing that separates
-- the same model reached two ways: `compass` means the turn went through Atlarix
-- Core, anything else means the user's own key. That is the difference the profile
-- card exists to show, and it cannot be recovered from the model id alone.
CREATE TABLE `edit_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`day` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`lines_added` integer DEFAULT 0 NOT NULL,
	`lines_removed` integer DEFAULT 0 NOT NULL,
	`edits` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `edit_stats_bucket_unique` ON `edit_stats` (`workspace_id`,`day`,`provider`,`model_id`);--> statement-breakpoint
CREATE INDEX `edit_stats_workspace_idx` ON `edit_stats` (`workspace_id`);
