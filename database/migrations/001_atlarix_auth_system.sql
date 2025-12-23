-- Atlarix Authentication System - Database Migration
-- ====================================================
-- Run this migration on pilgrimstack-db

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS TABLE (OAuth-based)
-- ============================================
CREATE TABLE IF NOT EXISTS atlarix_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    avatar_url TEXT,
    oauth_provider VARCHAR(50) NOT NULL, -- 'google' | 'github'
    oauth_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    last_sign_in TIMESTAMP,
    
    -- Indexes
    CONSTRAINT unique_oauth UNIQUE(oauth_provider, oauth_id)
);

CREATE INDEX idx_users_email ON atlarix_users(email);
CREATE INDEX idx_users_oauth ON atlarix_users(oauth_provider, oauth_id);

-- ============================================
-- SUBSCRIPTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS atlarix_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES atlarix_users(id) ON DELETE CASCADE,
    plan_type VARCHAR(50) NOT NULL, -- 'free' | 'monthly' | 'annual_sub' | 'annual_license'
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'cancelled'
    current_period_end TIMESTAMP,
    lemon_squeezy_id VARCHAR(255),
    lemon_squeezy_subscription_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Only one active subscription per user
    CONSTRAINT unique_active_subscription UNIQUE(user_id, status) 
        WHERE status = 'active'
);

CREATE INDEX idx_subscriptions_user ON atlarix_subscriptions(user_id);
CREATE INDEX idx_subscriptions_lemon ON atlarix_subscriptions(lemon_squeezy_id);

-- ============================================
-- VERSION ENTITLEMENTS (for annual licenses)
-- ============================================
CREATE TABLE IF NOT EXISTS atlarix_version_entitlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES atlarix_users(id) ON DELETE CASCADE,
    version VARCHAR(10) NOT NULL, -- 'v1', 'v2', 'v3'
    purchased_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    
    -- One entitlement per user per version
    CONSTRAINT unique_user_version UNIQUE(user_id, version)
);

CREATE INDEX idx_entitlements_user ON atlarix_version_entitlements(user_id);

-- ============================================
-- DEVICES TABLE (5 device limit tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS atlarix_devices (
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

-- ============================================
-- PROMPT USAGE (free tier only)
-- ============================================
CREATE TABLE IF NOT EXISTS atlarix_prompt_usage (
    user_id UUID NOT NULL REFERENCES atlarix_users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    count INTEGER DEFAULT 0,
    
    PRIMARY KEY (user_id, date)
);

CREATE INDEX idx_prompt_usage_date ON atlarix_prompt_usage(date);

-- ============================================
-- LEMON SQUEEZY WEBHOOKS LOG
-- ============================================
CREATE TABLE IF NOT EXISTS atlarix_webhook_logs (
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
-- TRIGGER: Update updated_at timestamp
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
-- SEED DATA: Create a test user (optional)
-- ============================================
-- Uncomment to insert test data

-- INSERT INTO atlarix_users (email, name, oauth_provider, oauth_id)
-- VALUES ('test@atlarix.com', 'Test User', 'google', 'test-oauth-id-123')
-- ON CONFLICT (email) DO NOTHING;

-- Get the test user ID and create a free subscription
-- WITH test_user AS (
--     SELECT id FROM atlarix_users WHERE email = 'test@atlarix.com'
-- )
-- INSERT INTO atlarix_subscriptions (user_id, plan_type, status)
-- SELECT id, 'free', 'active' FROM test_user
-- ON CONFLICT DO NOTHING;

-- ============================================
-- VIEWS: Helpful queries
-- ============================================

-- Active users with their subscription info
CREATE OR REPLACE VIEW atlarix_active_users AS
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

-- Daily prompt usage summary
CREATE OR REPLACE VIEW atlarix_prompt_stats AS
SELECT 
    date,
    COUNT(DISTINCT user_id) as active_users,
    SUM(count) as total_prompts,
    AVG(count) as avg_prompts_per_user
FROM atlarix_prompt_usage
GROUP BY date
ORDER BY date DESC;

-- ============================================
-- GRANT PERMISSIONS (adjust as needed)
-- ============================================
-- Grant permissions to your API user
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_api_user;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_api_user;

COMMIT;
