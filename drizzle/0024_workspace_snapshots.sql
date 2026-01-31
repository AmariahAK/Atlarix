CREATE TABLE `workspace_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`name` text NOT NULL,
	`files_json` text NOT NULL,
	`prompt_content` text,
	`diagram_content` text,
	`chat_messages_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_snapshots_app_id_idx` ON `workspace_snapshots` (`app_id`);
