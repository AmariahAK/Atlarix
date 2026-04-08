-- Unified snapshots: diagram version turn linkage, workspace file-hash manifest, message revert UI flag
ALTER TABLE `diagram_versions` ADD COLUMN `chat_turn_id` text;

--> statement-breakpoint

ALTER TABLE `diagrams` ADD COLUMN `last_snapshot_hashes` text;

--> statement-breakpoint

ALTER TABLE `messages` ADD COLUMN `is_reverted` integer DEFAULT 0 NOT NULL;
