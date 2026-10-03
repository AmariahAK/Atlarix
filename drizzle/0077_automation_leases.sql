-- Automations run in whichever Atlarix is open: the desktop app, the CLI, or both
-- at once on this same database. Each process arms its own timers, so without a
-- claim both would fire every scheduled run.
--
-- A LEASE PER OCCURRENCE. A process that wants to run an automation's
-- 09:00 occurrence (or one poll bucket of an MCP trigger) inserts
-- (automation_id, slot_key) first; the primary key lets exactly one insert
-- through and the loser skips. No clocks are compared and no lock is held, so a
-- process that dies mid-run leaves nothing to clean up but an old row, pruned
-- after a week.
--
-- `owner` / `heartbeat_at` on automation_runs: startup recovery used to mark
-- EVERY running run as interrupted, which with two processes would fail the
-- other one's live run. Now only a run whose owner stopped beating is recovered.
--
-- Additive only (a new table, two nullable columns): an older reader ignores
-- them, so min_reader stays where it is.
CREATE TABLE `automation_leases` (
	`automation_id` text NOT NULL,
	`slot_key` text NOT NULL,
	`owner` text NOT NULL,
	`claimed_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`automation_id`, `slot_key`)
);
--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `owner` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `heartbeat_at` integer;
