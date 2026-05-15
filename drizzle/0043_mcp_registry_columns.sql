-- Pass 7 — MCP marketplace: track entries that were installed from the
-- registry so the UI can show a "from marketplace" badge and offer one-click
-- removal / reconfigure.

ALTER TABLE `mcp_servers` ADD COLUMN `from_registry` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `registry_id` text;
