ALTER TABLE `chat_sessions` ADD COLUMN `kind` text DEFAULT 'normal' NOT NULL;
--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD COLUMN `status` text;
--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD COLUMN `status_error` text;
