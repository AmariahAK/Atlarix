CREATE TABLE `cleanup_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cleanup_date` integer DEFAULT (unixepoch()) NOT NULL,
	`sessions_deleted` integer DEFAULT 0 NOT NULL,
	`modifications_summarized` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_modifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_path` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer DEFAULT (unixepoch()) NOT NULL,
	`is_summary` integer DEFAULT 0 NOT NULL,
	`summary_of_period` text,
	`todo_reference` text,
	`files_modified` text,
	`changes_description` text,
	`ai_summary` text
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `last_used_at` integer DEFAULT (unixepoch()) NOT NULL;