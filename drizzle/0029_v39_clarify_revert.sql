-- v3.9: clarifying questions, conversation revert, message edit, stream tools
ALTER TABLE `chats` ADD `has_answered_questions` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `messages` ADD `exchange_index` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `messages` ADD `snapshot_id` integer;
--> statement-breakpoint
ALTER TABLE `messages` ADD `files_written` text;
