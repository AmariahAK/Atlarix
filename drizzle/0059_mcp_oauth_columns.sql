ALTER TABLE `mcp_servers` ADD COLUMN `auth_type` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `oauth_tokens_json` text;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `oauth_client_json` text;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `oauth_discovery_json` text;
