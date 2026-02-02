-- MCP workspace scope: global vs per-workspace (5 max global, 5 max per workspace)
ALTER TABLE mcp_servers ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE mcp_servers ADD COLUMN app_id INTEGER;
