CREATE TABLE `daily_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`date` integer DEFAULT (unixepoch()) NOT NULL,
	`micro_changes` text,
	`significant_actions` text,
	`files_touched` text,
	`diagram_changed` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_diagrams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`architecture` text NOT NULL,
	`dependencies` text,
	`flows` text,
	`trigger` text NOT NULL,
	`summary` text,
	`annotation` text,
	`files_changed` text,
	`hash` text NOT NULL,
	`protected` integer DEFAULT 0 NOT NULL,
	`compressed` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_diagrams_app_id_created_at_idx` ON `workspace_diagrams` (`app_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `apps` ADD `preferred_diagram_type` text DEFAULT 'architecture';--> statement-breakpoint
ALTER TABLE `diagram_versions` ADD `trigger` text;--> statement-breakpoint
ALTER TABLE `diagram_versions` ADD `summary` text;