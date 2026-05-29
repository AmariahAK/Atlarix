CREATE TABLE `workspace_command_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`category` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_command_permissions_app_category` ON `workspace_command_permissions` (`app_id`,`category`);--> statement-breakpoint
CREATE INDEX `workspace_command_permissions_app_id_idx` ON `workspace_command_permissions` (`app_id`);
