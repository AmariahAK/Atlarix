CREATE TABLE `openrouter_favorites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` text NOT NULL,
	`display_order` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `openrouter_favorites_model_id_unique` ON `openrouter_favorites` (`model_id`);