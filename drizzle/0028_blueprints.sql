-- Phase 7 Additive Blueprint: one blueprint per workspace (rooms, edges, functions)
CREATE TABLE IF NOT EXISTS `blueprints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	`content` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `blueprints_workspace_unique` ON `blueprints` (`workspace_id`);
