CREATE TABLE `atlarix_hooks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `trigger` text NOT NULL,
  `command` text NOT NULL,
  `args_json` text,
  `workspace_id` integer,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
