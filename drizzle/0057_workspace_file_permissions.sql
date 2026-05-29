CREATE TABLE `workspace_file_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`scope_type` text NOT NULL,
	`scope_value` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_file_permissions_app_scope` ON `workspace_file_permissions` (`app_id`,`scope_type`,`scope_value`);--> statement-breakpoint
CREATE INDEX `workspace_file_permissions_app_id_idx` ON `workspace_file_permissions` (`app_id`);
