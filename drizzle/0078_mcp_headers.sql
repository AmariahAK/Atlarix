-- Request headers for a local MCP server reached by URL.
--
-- A server could only send `Authorization: Bearer <api_key>`. Configs pasted or
-- imported from other tools (Cursor, VS Code, Claude Code) and MCP Registry
-- entries name their own headers (`X-Api-Key`, `X-Org-Id`, …), and an editor's
-- ACP `mcpServers` carries them too. Stored encrypted, like `env_json`.
--
-- Additive only (one nullable column): an older reader ignores it, so
-- min_reader stays where it is.
ALTER TABLE `mcp_servers` ADD `headers_json` text;
