CREATE TABLE `custom_commands` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `prompt_template` text NOT NULL,
  `mode_override` text,
  `workspace_id` integer,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);

CREATE UNIQUE INDEX `custom_commands_name_workspace` ON `custom_commands` (`name`, COALESCE(`workspace_id`, -1));
