-- Atlarix Database - Fresh Setup
-- ================================
-- WARNING: This will DROP ALL existing tables!
-- Only run this if you're sure you want to start fresh.

BEGIN;

-- ============================================
-- DROP ALL EXISTING TABLES (if any)
-- ============================================

-- Drop all tables (add more if you have existing tables)
DROP TABLE IF EXISTS atlarix_webhook_logs CASCADE;
DROP TABLE IF EXISTS atlarix_prompt_usage CASCADE;
DROP TABLE IF EXISTS atlarix_devices CASCADE;
DROP TABLE IF EXISTS atlarix_version_entitlements CASCADE;
DROP TABLE IF EXISTS atlarix_subscriptions CASCADE;
DROP TABLE IF EXISTS atlarix_users CASCADE;

-- Drop any other existing tables you want to remove
-- DROP TABLE IF EXISTS your_old_table CASCADE;

-- Drop views if they exist
DROP VIEW IF EXISTS atlarix_prompt_stats;
DROP VIEW IF EXISTS atlarix_active_users;

-- Drop functions
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- CREATE NEW ATLARIX SCHEMA
-- ============================================

-- USERS TABLE (OAuth-based)
CREATE TABLE atlarix_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    avatar_url TEXT,
    oauth_provider VARCHAR(50) NOT NULL, -- 'google' | 'github'
    oauth_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    last_sign_in TIMESTAMP,
    
    CONSTRAINT unique_oauth UNIQUE(oauth_provider, oauth_id)
);

CREATE INDEX idx_users_email ON atlarix_users(email);
CREATE INDEX idx_users_oauth ON atlarix_users(oauth_provider, oauth_id);

-- SUBSCRIPTIONS TABLE
CREATE TABLE atlarix_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES atlarix_users(id) ON DELETE CASCADE,
    plan_type VARCHAR(50) NOT NULL, -- 'free' | 'monthly' | 'annual_sub' | 'annual_license'
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'cancelled'
    current_period_end TIMESTAMP,
    lemon_squeezy_id VARCHAR(255),
    lemon_squeezy_subscription_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT unique_active_subscription UNIQUE(user_id, status) 
        WHERE status = 'active'
);

CREATE INDEX idx_subscriptions_user ON atlarix_subscriptions(user_id);
CREATE INDEX idx_subscriptions_lemon ON atlarix_subscriptions(lemon_squeezy_id);

-- VERSION ENTITLEMENTS (for annual licenses)
CREATE TABLE atlarix_version_entitlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES atlarix_users(id) ON DELETE CASCADE,
    version VARCHAR(10) NOT NULL, -- 'v1', 'v2', 'v3'
    purchased_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    
    CONSTRAINT unique_user_version UNIQUE(user_id, version)
);

CREATE INDEX idx_entitlements_user ON atlarix_version_entitlements(user_id);

-- DEVICES TABLE (5 device limit tracking)
CREATE TABLE atlarix_devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES atlarix_users(id) ON DELETE CASCADE,
    device_id VARCHAR(255) UNIQUE NOT NULL,
    device_name VARCHAR(255),
    os VARCHAR(50), -- 'macOS' | 'Windows' | 'Linux'
    last_active TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_devices_user ON atlarix_devices(user_id);
CREATE INDEX idx_devices_device_id ON atlarix_devices(device_id);

-- PROMPT USAGE (free tier only)
CREATE TABLE atlarix_prompt_usage (
    user_id UUID NOT NULL REFERENCES atlarix_users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    count INTEGER DEFAULT 0,
    
    PRIMARY KEY (user_id, date)
);

CREATE INDEX idx_prompt_usage_date ON atlarix_prompt_usage(date);

-- LEMON SQUEEZY WEBHOOKS LOG
CREATE TABLE atlarix_webhook_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(100) NOT NULL,
    event_id VARCHAR(255),
    payload JSONB NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP
);

CREATE INDEX idx_webhooks_event ON atlarix_webhook_logs(event_type);
CREATE INDEX idx_webhooks_processed ON atlarix_webhook_logs(processed);

-- ============================================
-- TRIGGERS
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_subscriptions_updated_at 
    BEFORE UPDATE ON atlarix_subscriptions 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- VIEWS
-- ============================================

CREATE VIEW atlarix_active_users AS
SELECT 
    u.id,
    u.email,
    u.name,
    u.oauth_provider,
    u.created_at as user_created_at,
    u.last_sign_in,
    s.plan_type,
    s.status as subscription_status,
    s.current_period_end,
    COUNT(DISTINCT d.id) as device_count
FROM atlarix_users u
LEFT JOIN atlarix_subscriptions s ON u.id = s.user_id AND s.status = 'active'
LEFT JOIN atlarix_devices d ON u.id = d.user_id
GROUP BY u.id, u.email, u.name, u.oauth_provider, u.created_at, u.last_sign_in,
         s.plan_type, s.status, s.current_period_end;

CREATE VIEW atlarix_prompt_stats AS
SELECT 
    date,
    COUNT(DISTINCT user_id) as active_users,
    SUM(count) as total_prompts,
    AVG(count) as avg_prompts_per_user
FROM atlarix_prompt_usage
GROUP BY date
ORDER BY date DESC;

COMMIT;

-- ============================================
-- VERIFICATION
-- ============================================

-- List all created tables
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name LIKE 'atlarix_%'
ORDER BY table_name;

-- Expected output:
-- atlarix_devices
-- atlarix_prompt_usage
-- atlarix_subscriptions
-- atlarix_users
-- atlarix_version_entitlements
-- atlarix_webhook_logs
