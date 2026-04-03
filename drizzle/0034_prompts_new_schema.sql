-- Migrate prompts table from old schema (title, description) to new schema (type, workspace_id)
CREATE TABLE `prompts_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `type` text NOT NULL DEFAULT 'global',
  `workspace_id` integer,
  `content` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);

--> statement-breakpoint

INSERT INTO `prompts_new` (`id`, `type`, `workspace_id`, `content`, `created_at`, `updated_at`)
SELECT `id`, 'global', NULL, `content`, `created_at`, `updated_at`
FROM `prompts`;

--> statement-breakpoint

DROP TABLE `prompts`;

--> statement-breakpoint

ALTER TABLE `prompts_new` RENAME TO `prompts`;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `prompts_workspace_unique` ON `prompts` (`workspace_id`);
