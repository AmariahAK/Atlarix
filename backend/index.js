/**
 * Atlarix Backend API
 * ===================
 * Authentication, subscription management, and device tracking
 */

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'atlarix-api', version: '1.0.0' });
});

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

/**
 * POST /api/auth/google
 * Exchange Google OAuth code for user session
 */
app.post('/api/auth/google', async (req, res) => {
    try {
        const { code, email, name, avatar } = req.body;

        // TODO: Verify Google OAuth token
        // For now, just create/update user

        const result = await pool.query(
            `INSERT INTO atlarix_users (email, name, avatar_url, oauth_provider, oauth_id, last_sign_in)
       VALUES ($1, $2, $3, 'google', $4, NOW())
       ON CONFLICT (oauth_provider, oauth_id) 
       DO UPDATE SET 
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url,
         last_sign_in = NOW()
       RETURNING *`,
            [email, name, avatar, code]
        );

        const user = result.rows[0];

        // Create free subscription if doesn't exist
        await pool.query(
            `INSERT INTO atlarix_subscriptions (user_id, plan_type, status)
       VALUES ($1, 'free', 'active')
       ON CONFLICT (user_id, status) WHERE status = 'active' DO NOTHING`,
            [user.id]
        );

        res.json({ success: true, user });
    } catch (error) {
        console.error('Google auth error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/auth/github
 * Exchange GitHub OAuth code for user session
 */
app.post('/api/auth/github', async (req, res) => {
    try {
        const { code, email, name, avatar } = req.body;

        // TODO: Verify GitHub OAuth token

        const result = await pool.query(
            `INSERT INTO atlarix_users (email, name, avatar_url, oauth_provider, oauth_id, last_sign_in)
       VALUES ($1, $2, $3, 'github', $4, NOW())
       ON CONFLICT (oauth_provider, oauth_id) 
       DO UPDATE SET 
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url,
         last_sign_in = NOW()
       RETURNING *`,
            [email, name, avatar, code]
        );

        const user = result.rows[0];

        // Create free subscription if doesn't exist
        await pool.query(
            `INSERT INTO atlarix_subscriptions (user_id, plan_type, status)
       VALUES ($1, 'free', 'active')
       ON CONFLICT (user_id, status) WHERE status = 'active' DO NOTHING`,
            [user.id]
        );

        res.json({ success: true, user });
    } catch (error) {
        console.error('GitHub auth error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// USER STATUS ENDPOINT
// ============================================

/**
 * GET /api/user/status/:userId
 * Get complete user status (subscription, prompts, devices)
 */
app.get('/api/user/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const result = await pool.query(
            `WITH subscription_info AS (
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
          COUNT(*) as device_count,
          json_agg(json_build_object(
            'id', id,
            'device_id', device_id,
            'device_name', device_name,
            'os', os,
            'last_active', last_active
          ) ORDER BY last_active DESC) as devices
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
        d.devices as device_list,
        5 as max_devices
      FROM atlarix_users u
      LEFT JOIN subscription_info s ON u.id = s.user_id
      LEFT JOIN version_info v ON u.id = v.user_id
      LEFT JOIN prompt_info p ON u.id = p.user_id
      LEFT JOIN device_info d ON u.id = d.user_id
      WHERE u.id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('User status error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// PROMPT USAGE ENDPOINT
// ============================================

/**
 * POST /api/prompts/use
 * Increment prompt usage (free tier only)
 */
app.post('/api/prompts/use', async (req, res) => {
    try {
        const { userId } = req.body;

        // Check if user is on free tier
        const subCheck = await pool.query(
            `SELECT plan_type FROM atlarix_subscriptions 
       WHERE user_id = $1 AND status = 'active'`,
            [userId]
        );

        const plan = subCheck.rows[0]?.plan_type || 'free';

        if (plan !== 'free') {
            return res.json({
                success: true,
                unlimited: true,
                prompts_remaining: null
            });
        }

        // Increment usage
        const result = await pool.query(
            `INSERT INTO atlarix_prompt_usage (user_id, date, count)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (user_id, date) 
       DO UPDATE SET count = atlarix_prompt_usage.count + 1
       RETURNING count`,
            [userId]
        );

        const used = result.rows[0].count;
        const remaining = Math.max(5 - used, 0);

        res.json({
            success: true,
            prompts_used: used,
            prompts_remaining: remaining,
            limit_reached: used >= 5
        });
    } catch (error) {
        console.error('Prompt usage error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// DEVICE MANAGEMENT
// ============================================

/**
 * POST /api/device/register
 * Register a device for a user
 */
app.post('/api/device/register', async (req, res) => {
    try {
        const { userId, deviceId, deviceName, os } = req.body;

        // Check device limit
        const countResult = await pool.query(
            'SELECT COUNT(*) as count FROM atlarix_devices WHERE user_id = $1',
            [userId]
        );

        if (parseInt(countResult.rows[0].count) >= 5) {
            return res.status(403).json({
                error: 'Device limit reached',
                max_devices: 5
            });
        }

        // Register device
        const result = await pool.query(
            `INSERT INTO atlarix_devices (user_id, device_id, device_name, os)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (device_id) 
       DO UPDATE SET last_active = NOW()
       RETURNING *`,
            [userId, deviceId, deviceName, os]
        );

        res.json({ success: true, device: result.rows[0] });
    } catch (error) {
        console.error('Device registration error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/device/:deviceId
 * Remove a device
 */
app.delete('/api/device/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { userId } = req.body;

        await pool.query(
            'DELETE FROM atlarix_devices WHERE user_id = $1 AND device_id = $2',
            [userId, deviceId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Device removal error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// LEMON SQUEEZY WEBHOOKS
// ============================================

/**
 * POST /api/webhooks/lemon-squeezy
 * Handle Lemon Squeezy payment webhooks
 */
app.post('/api/webhooks/lemon-squeezy', async (req, res) => {
    try {
        const event = req.body;

        // Log webhook
        await pool.query(
            `INSERT INTO atlarix_webhook_logs (event_type, event_id, payload)
       VALUES ($1, $2, $3)`,
            [event.meta?.event_name, event.data?.id, JSON.stringify(event)]
        );

        // TODO: Verify webhook signature

        // Handle different event types
        switch (event.meta?.event_name) {
            case 'subscription_created':
            case 'subscription_updated':
                // Update subscription
                await handleSubscriptionUpdate(event.data);
                break;

            case 'subscription_cancelled':
                await handleSubscriptionCancellation(event.data);
                break;

            default:
                console.log('Unhandled webhook:', event.meta?.event_name);
        }

        res.json({ received: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

async function handleSubscriptionUpdate(data) {
    // TODO: Implement subscription update logic
    console.log('Subscription update:', data);
}

async function handleSubscriptionCancellation(data) {
    // TODO: Implement cancellation logic
    console.log('Subscription cancelled:', data);
}

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`✅ Atlarix API running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing server...');
    await pool.end();
    process.exit(0);
});
