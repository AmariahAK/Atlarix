ALTER TABLE `chat_context_summaries` ADD COLUMN `compaction_generation` integer DEFAULT 0 NOT NULL;
ALTER TABLE `messages` ADD COLUMN `is_synthetic` integer DEFAULT 0 NOT NULL;
