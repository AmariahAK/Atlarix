-- v5.0 Section 2: Project memory
CREATE TABLE IF NOT EXISTS `project_snapshots` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `workspace_id` integer NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `blueprint_json` text NOT NULL,
  `plan_md` text,
  `diagram_mermaid` text,
  `git_commit_hash` text,
  `session_summary` text,
  `trigger` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `project_snapshots_workspace_created_idx` ON `project_snapshots` (`workspace_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `project_memory` (
  `workspace_id` integer NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  `key` text NOT NULL,
  `value` text NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  PRIMARY KEY (`workspace_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `project_memory_workspace_idx` ON `project_memory` (`workspace_id`);
