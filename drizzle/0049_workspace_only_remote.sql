DELETE FROM mcp_servers WHERE scope = 'global';
--> statement-breakpoint
DELETE FROM installed_skills WHERE scope = 'global';
--> statement-breakpoint
DELETE FROM prompts WHERE type = 'global';
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN last_opened_at INTEGER;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'local';
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN remote_connection TEXT;
