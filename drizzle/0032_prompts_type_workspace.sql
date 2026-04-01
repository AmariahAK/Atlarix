ALTER TABLE prompts ADD COLUMN type TEXT NOT NULL DEFAULT 'global';
--> statement-breakpoint
ALTER TABLE prompts ADD COLUMN workspace_id integer;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS prompts_workspace_unique ON prompts (workspace_id);
