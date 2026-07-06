-- Automations: persisted locally-executed recurring agent runs (definitions)
-- and their triage-feed run history (transcripts live in chat_sessions
-- kind="background" rows; session_id links them).
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` integer,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`trigger` text NOT NULL,
	`prompt` text NOT NULL,
	`run_mode` text DEFAULT 'read-only' NOT NULL,
	`model` text,
	`cursor` text,
	`last_run_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`session_id` text,
	`status` text NOT NULL,
	`summary` text,
	`error` text,
	`unread` integer DEFAULT true NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`proposal_diff` text,
	`proposal_files` text,
	`proposal_applied_at` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `automation_runs_automation_id_idx` ON `automation_runs` (`automation_id`);
