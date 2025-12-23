-- Rollback Migration for Atlarix Authentication System
-- =====================================================
-- Run this to undo the authentication system migration

BEGIN;

-- Drop views
DROP VIEW IF EXISTS atlarix_prompt_stats;
DROP VIEW IF EXISTS atlarix_active_users;

-- Drop triggers
DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON atlarix_subscriptions;
DROP FUNCTION IF EXISTS update_updated_at_column();

-- Drop tables (in reverse order due to foreign keys)
DROP TABLE IF EXISTS atlarix_webhook_logs;
DROP TABLE IF EXISTS atlarix_prompt_usage;
DROP TABLE IF EXISTS atlarix_devices;
DROP TABLE IF EXISTS atlarix_version_entitlements;
DROP TABLE IF EXISTS atlarix_subscriptions;
DROP TABLE IF EXISTS atlarix_users;

COMMIT;
