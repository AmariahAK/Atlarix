-- Manual migration to create provider_api_keys table
-- Run this if automatic migration didn't work

CREATE TABLE IF NOT EXISTS provider_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  provider_id TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
);

-- Create unique index on provider_id
CREATE UNIQUE INDEX IF NOT EXISTS provider_api_keys_provider_id_unique ON provider_api_keys (provider_id);
