CREATE TABLE IF NOT EXISTS `pivot_nodes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `workspace_id` integer NOT NULL REFERENCES `apps`(`id`) ON DELETE CASCADE,
  `external_id` text NOT NULL,
  `type` text NOT NULL,
  `label` text NOT NULL,
  `file_path` text NOT NULL,
  `range_start` integer,
  `range_end` integer,
  `metadata` text
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pivot_nodes_workspace_idx` ON `pivot_nodes` (`workspace_id`);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pivot_nodes_workspace_external_unique` ON `pivot_nodes` (`workspace_id`, `external_id`);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pivot_edges` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `workspace_id` integer NOT NULL REFERENCES `apps`(`id`) ON DELETE CASCADE,
  `from_id` text NOT NULL,
  `to_id` text NOT NULL,
  `type` text NOT NULL,
  `metadata` text
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pivot_edges_workspace_idx` ON `pivot_edges` (`workspace_id`);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pivot_containers` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` integer NOT NULL REFERENCES `apps`(`id`) ON DELETE CASCADE,
  `label` text NOT NULL,
  `intent` text,
  `position` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pivot_beacons` (
  `id` text PRIMARY KEY NOT NULL,
  `container_id` text NOT NULL REFERENCES `pivot_containers`(`id`) ON DELETE CASCADE,
  `label` text NOT NULL,
  `kind` text NOT NULL,
  `description` text,
  `file_path` text,
  `position` text
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `blueprint_snapshots` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `workspace_id` integer NOT NULL REFERENCES `apps`(`id`) ON DELETE CASCADE,
  `snapshot_at` integer DEFAULT (unixepoch()) NOT NULL,
  `blueprint_json` text NOT NULL,
  `source` text NOT NULL
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `blueprint_snapshots_workspace_idx` ON `blueprint_snapshots` (`workspace_id`);
