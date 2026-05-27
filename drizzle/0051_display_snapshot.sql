ALTER TABLE `messages` ADD COLUMN `display_snapshot` text;
--> statement-breakpoint
ALTER TABLE `session_messages` ADD COLUMN `display_snapshot` text;
