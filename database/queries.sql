/**
 * Sample Queries for Atlarix Authentication System
 * =================================================
 * Common database queries for the pilgrimstack API
 */

-- ============================================
-- USER MANAGEMENT
-- ============================================

-- Create new user from OAuth
INSERT INTO atlarix_users (email, name, avatar_url, oauth_provider, oauth_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (oauth_provider, oauth_id) 
DO UPDATE SET 
    email = EXCLUDED.email,
    name = EXCLUDED.name,
    avatar_url = EXCLUDED.avatar_url,
    last_sign_in = NOW()
RETURNING *;

-- Find user by email
SELECT * FROM atlarix_users WHERE email = $1;

-- Find user by OAuth credentials
SELECT * FROM atlarix_users 
WHERE oauth_provider = $1 AND oauth_id = $2;

-- Update last sign-in
UPDATE atlarix_users 
SET last_sign_in = NOW() 
WHERE id = $1;

-- ============================================
-- SUBSCRIPTION MANAGEMENT
-- ============================================

-- Get user's active subscription
SELECT s.*, u.email, u.name
FROM atlarix_subscriptions s
JOIN atlarix_users u ON s.user_id = u.id
WHERE s.user_id = $1 AND s.status = 'active'
LIMIT 1;

-- Create new subscription (from webhook)
INSERT INTO atlarix_subscriptions (
    user_id, 
    plan_type, 
    status, 
    current_period_end,
    lemon_squeezy_id
)
VALUES ($1, $2, 'active', $3, $4)
RETURNING *;

-- Update subscription status
UPDATE atlarix_subscriptions
SET status = $1, updated_at = NOW()
WHERE lemon_squeezy_id = $2;

-- Cancel subscription
UPDATE atlarix_subscriptions
SET status = 'cancelled', updated_at = NOW()
WHERE user_id = $1 AND status = 'active';

-- Check if user has Pro access
SELECT EXISTS(
    SELECT 1 FROM atlarix_subscriptions
    WHERE user_id = $1 
    AND status = 'active'
    AND plan_type IN ('monthly', 'annual_sub', 'annual_license')
) AS has_pro;

-- ============================================
-- VERSION ENTITLEMENTS
-- ============================================

-- Get user's version access
SELECT version FROM atlarix_version_entitlements
WHERE user_id = $1 
AND (expires_at IS NULL OR expires_at > NOW());

-- Grant version access (annual license purchase)
INSERT INTO atlarix_version_entitlements (user_id, version, expires_at)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, version) DO NOTHING;

-- Check if user has access to specific version
SELECT EXISTS(
    SELECT 1 FROM atlarix_version_entitlements
    WHERE user_id = $1 
    AND version = $2
    AND (expires_at IS NULL OR expires_at > NOW())
) AS has_access;

-- ============================================
-- DEVICE MANAGEMENT
-- ============================================

-- Register new device
INSERT INTO atlarix_devices (user_id, device_id, device_name, os)
VALUES ($1, $2, $3, $4)
ON CONFLICT (device_id) 
DO UPDATE SET last_active = NOW()
RETURNING *;

-- Get user's devices
SELECT * FROM atlarix_devices
WHERE user_id = $1
ORDER BY last_active DESC;

-- Count user's devices
SELECT COUNT(*) as device_count
FROM atlarix_devices
WHERE user_id = $1;

-- Remove device
DELETE FROM atlarix_devices
WHERE user_id = $1 AND device_id = $2;

-- Check device limit (max 5)
SELECT COUNT(*) >= 5 as at_limit
FROM atlarix_devices
WHERE user_id = $1;

-- ============================================
-- PROMPT USAGE (Free Tier)
-- ============================================

-- Get today's prompt count
SELECT COALESCE(count, 0) as prompts_used
FROM atlarix_prompt_usage
WHERE user_id = $1 AND date = CURRENT_DATE;

-- Increment prompt usage
INSERT INTO atlarix_prompt_usage (user_id, date, count)
VALUES ($1, CURRENT_DATE, 1)
ON CONFLICT (user_id, date) 
DO UPDATE SET count = atlarix_prompt_usage.count + 1
RETURNING count;

-- Check if user can send prompt (free tier)
WITH usage AS (
    SELECT COALESCE(count, 0) as used
    FROM atlarix_prompt_usage
    WHERE user_id = $1 AND date = CURRENT_DATE
),
subscription AS (
    SELECT plan_type
    FROM atlarix_subscriptions
    WHERE user_id = $1 AND status = 'active'
)
SELECT 
    CASE 
        WHEN s.plan_type IN ('monthly', 'annual_sub', 'annual_license') THEN TRUE
        WHEN u.used < 5 THEN TRUE
        ELSE FALSE
    END as can_send
FROM usage u
CROSS JOIN subscription s;

-- Get remaining prompts for today
SELECT 
    CASE 
        WHEN plan_type IN ('monthly', 'annual_sub', 'annual_license') THEN NULL
        ELSE GREATEST(5 - COALESCE(pu.count, 0), 0)
    END as prompts_remaining
FROM atlarix_subscriptions s
LEFT JOIN atlarix_prompt_usage pu ON s.user_id = pu.user_id AND pu.date = CURRENT_DATE
WHERE s.user_id = $1 AND s.status = 'active';

-- ============================================
-- USER STATUS (Complete)
-- ============================================

-- Get complete user status (for API /user/status endpoint)
WITH subscription_info AS (
    SELECT 
        user_id,
        plan_type,
        status,
        current_period_end
    FROM atlarix_subscriptions
    WHERE user_id = $1 AND status = 'active'
),
version_info AS (
    SELECT 
        user_id,
        ARRAY_AGG(version ORDER BY version) as versions
    FROM atlarix_version_entitlements
    WHERE user_id = $1 
    AND (expires_at IS NULL OR expires_at > NOW())
    GROUP BY user_id
),
prompt_info AS (
    SELECT 
        user_id,
        count as prompts_used
    FROM atlarix_prompt_usage
    WHERE user_id = $1 AND date = CURRENT_DATE
),
device_info AS (
    SELECT 
        user_id,
        COUNT(*) as device_count
    FROM atlarix_devices
    WHERE user_id = $1
    GROUP BY user_id
)
SELECT 
    u.id,
    u.email,
    u.name,
    u.avatar_url,
    u.oauth_provider,
    COALESCE(s.plan_type, 'free') as plan,
    COALESCE(s.status, 'active') as status,
    s.current_period_end,
    v.versions,
    CASE 
        WHEN s.plan_type IS NULL OR s.plan_type = 'free' 
        THEN GREATEST(5 - COALESCE(p.prompts_used, 0), 0)
        ELSE NULL
    END as prompts_remaining,
    COALESCE(d.device_count, 0) as devices,
    5 as max_devices
FROM atlarix_users u
LEFT JOIN subscription_info s ON u.id = s.user_id
LEFT JOIN version_info v ON u.id = v.user_id
LEFT JOIN prompt_info p ON u.id = p.user_id
LEFT JOIN device_info d ON u.id = d.user_id
WHERE u.id = $1;

-- ============================================
-- WEBHOOK LOGGING
-- ============================================

-- Log webhook event
INSERT INTO atlarix_webhook_logs (event_type, event_id, payload)
VALUES ($1, $2, $3)
RETURNING id;

-- Mark webhook as processed
UPDATE atlarix_webhook_logs
SET processed = TRUE, processed_at = NOW()
WHERE id = $1;

-- Get unprocessed webhooks
SELECT * FROM atlarix_webhook_logs
WHERE processed = FALSE
ORDER BY created_at ASC
LIMIT 100;

-- ============================================
-- ANALYTICS
-- ============================================

-- Daily active users
SELECT 
    DATE(last_sign_in) as date,
    COUNT(DISTINCT id) as active_users
FROM atlarix_users
WHERE last_sign_in >= NOW() - INTERVAL '30 days'
GROUP BY DATE(last_sign_in)
ORDER BY date DESC;

-- Subscription breakdown
SELECT 
    plan_type,
    status,
    COUNT(*) as count
FROM atlarix_subscriptions
GROUP BY plan_type, status;

-- Conversion rate (free to paid)
SELECT 
    COUNT(CASE WHEN plan_type = 'free' THEN 1 END)::FLOAT / COUNT(*) * 100 as free_percentage,
    COUNT(CASE WHEN plan_type IN ('monthly', 'annual_sub') THEN 1 END)::FLOAT / COUNT(*) * 100 as paid_percentage
FROM atlarix_subscriptions
WHERE status = 'active';
