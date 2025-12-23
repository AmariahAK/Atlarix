# Atlarix Database Migration Guide

## Overview
This guide explains how to set up the Atlarix authentication database on your existing `norahlabs-db`.

## Prerequisites
- Access to `norahlabs-db` PostgreSQL database
- Database credentials in `.env` file
- PostgreSQL client (psql) or GUI tool (pgAdmin, TablePlus, etc.)

## Migration Files

### 1. `001_atlarix_auth_system.sql`
Main migration that creates:
- `atlarix_users` - OAuth user accounts
- `atlarix_subscriptions` - Plan management (free/monthly/annual)
- `atlarix_version_entitlements` - Version access for annual licenses
- `atlarix_devices` - Device tracking (5 device limit)
- `atlarix_prompt_usage` - Free tier prompt counting
- `atlarix_webhook_logs` - Lemon Squeezy webhook history

### 2. `001_rollback.sql`
Rollback script to undo changes if needed.

## Running the Migration

### Option 1: Using psql (Command Line)

```bash
# Connect to your database
psql postgresql://user:password@host:5432/norahlabs_db

# Run migration
\i database/migrations/001_atlarix_auth_system.sql

# Verify tables were created
\dt atlarix_*
```

### Option 2: Using a GUI Tool

1. Open your PostgreSQL GUI client
2. Connect to `norahlabs-db`
3. Open `001_atlarix_auth_system.sql`
4. Execute the script
5. Verify all tables appear

### Option 3: Using Node.js Script

Create `scripts/migrate.js`:

```javascript
const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const sql = fs.readFileSync('database/migrations/001_atlarix_auth_system.sql', 'utf8');
  
  try {
    await pool.query(sql);
    console.log('✅ Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await pool.end();
  }
}

migrate();
```

Run: `node scripts/migrate.js`

## Verification

After running the migration, verify tables exist:

```sql
-- List all Atlarix tables
SELECT table_name 
FROM information_schema.tables 
WHERE table_name LIKE 'atlarix_%';

-- Expected output:
-- atlarix_users
-- atlarix_subscriptions
-- atlarix_version_entitlements
-- atlarix_devices
-- atlarix_prompt_usage
-- atlarix_webhook_logs
```

## Connection Configuration

Update your backend API to use these environment variables:

```env
# PostgreSQL Database (norahlabs-db)
DATABASE_URL=postgresql://user:password@host:5432/norahlabs_db
DATABASE_HOST=your-host.com
DATABASE_PORT=5432
DATABASE_NAME=norahlabs_db
DATABASE_USER=your_user
DATABASE_PASSWORD=your_password

# Use SSL for production
DATABASE_SSL=true
```

## Testing the Schema

### Create a Test User

```sql
-- Insert test user
INSERT INTO atlarix_users (email, name, oauth_provider, oauth_id)
VALUES ('test@atlarix.com', 'Test User', 'google', 'google-123456')
RETURNING id;

-- Create free subscription
INSERT INTO atlarix_subscriptions (user_id, plan_type, status)
VALUES ('user-id-from-above', 'free', 'active');

-- Register a device
INSERT INTO atlarix_devices (user_id, device_id, device_name, os)
VALUES ('user-id-from-above', 'test-device-1', 'Test MacBook', 'macOS');
```

### Test Queries

```sql
-- Get user with subscription info
SELECT * FROM atlarix_active_users WHERE email = 'test@atlarix.com';

-- Check prompt usage
SELECT * FROM atlarix_prompt_usage 
WHERE user_id = 'some-user-id' 
AND date = CURRENT_DATE;

-- Count devices for user
SELECT COUNT(*) FROM atlarix_devices WHERE user_id = 'some-user-id';
```

## Rollback (If Needed)

If you need to undo the migration:

```bash
psql postgresql://user:password@host:5432/norahlabs_db \
  -f database/migrations/001_rollback.sql
```

⚠️ **Warning**: This will delete all Atlarix authentication data!

## Next Steps

After migration:

1. ✅ Database schema created
2. 🔄 Update API endpoints to use these tables
3. 🔄 Configure Lemon Squeezy webhooks
4. 🔄 Setup OAuth (Google, GitHub)
5. 🔄 Test authentication flow

## Troubleshooting

### Permission Denied Error

```sql
-- Grant permissions to your API user
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_api_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_api_user;
```

### UUID Extension Not Found

```sql
-- Install UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

### Connection Issues

- Verify DATABASE_URL in `.env`
- Check firewall allows PostgreSQL port (5432)
- Ensure SSL is configured correctly

## Support

For issues, check:
- PostgreSQL logs
- Database connection settings
- Migration file syntax
