# Atlarix Database Setup - Fresh Installation

## ⚠️ WARNING
This will **DELETE ALL existing data** in your norahlabs database and create a fresh Atlarix authentication system.

## Quick Setup

### Option 1: Using psql (Recommended)

```bash
# Connect and run the setup
psql $DATABASE_URL -f database/setup_fresh.sql

# Or with connection string
psql "postgresql://user:password@host:5432/norahlabs_db" -f database/setup_fresh.sql
```

### Option 2: Using Node.js

Create `scripts/setup-db.js`:

```javascript
const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // For hosted databases (Fly.io, Heroku, etc.)
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function setupDatabase() {
  console.log('🔄 Setting up fresh Atlarix database...');
  
  const sql = fs.readFileSync('database/setup_fresh.sql', 'utf8');
  
  try {
    await pool.query(sql);
    console.log('✅ Database setup completed successfully!');
    console.log('\nCreated tables:');
    console.log('  - atlarix_users');
    console.log('  - atlarix_subscriptions');
    console.log('  - atlarix_version_entitlements');
    console.log('  - atlarix_devices');
    console.log('  - atlarix_prompt_usage');
    console.log('  - atlarix_webhook_logs');
  } catch (error) {
    console.error('❌ Database setup failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

setupDatabase();
```

Then run:
```bash
npm install pg
node scripts/setup-db.js
```

### Option 3: GUI Tool (pgAdmin, TablePlus, etc.)

1. Open your PostgreSQL client
2. Connect to `norahlabs-db`
3. Open `database/setup_fresh.sql`
4. Execute the entire script
5. Verify tables in the schema browser

## Environment Variables

Make sure these are in your `.env`:

```env
# Database (norahlabs-db)
DATABASE_URL=postgresql://user:password@host:port/database
DATABASE_SSL=true  # Set to true for hosted databases
```

## Verification

After setup, verify tables exist:

```sql
-- List all tables
\dt atlarix_*

-- Or with SQL
SELECT table_name 
FROM information_schema.tables 
WHERE table_name LIKE 'atlarix_%';
```

Expected output:
```
 atlarix_devices
 atlarix_prompt_usage
 atlarix_subscriptions
 atlarix_users
 atlarix_version_entitlements
 atlarix_webhook_logs
```

## What's Created

### Tables
- **atlarix_users** - OAuth user accounts (Google/GitHub)
- **atlarix_subscriptions** - Plan management (Free/Monthly/Annual)
- **atlarix_version_entitlements** - Version access for licenses
- **atlarix_devices** - Device tracking (5 device limit)
- **atlarix_prompt_usage** - Free tier prompt counting (5/day)
- **atlarix_webhook_logs** - Lemon Squeezy event history

### Views
- **atlarix_active_users** - Users with subscription info
- **atlarix_prompt_stats** - Daily usage statistics

### Indexes
All tables have proper indexes for:
- User lookups by email
- OAuth provider queries
- Device management
- Prompt counting
- Webhook processing

## Next Steps

1. ✅ Database created
2. 🔄 Create backend API endpoints
3. 🔄 Configure OAuth (Google, GitHub)
4. 🔄 Setup Lemon Squeezy webhooks
5. 🔄 Test authentication flow

## Troubleshooting

### "Permission denied" error
```sql
-- Grant permissions to your API user
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_api_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_api_user;
```

### "Extension uuid-ossp does not exist"
```sql
-- Install extension (requires superuser)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

### Connection refused
- Check DATABASE_URL is correct
- Verify firewall allows port 5432
- Ensure database server is running

## Sample Data (Optional)

To create a test user:

```sql
-- Insert test user
INSERT INTO atlarix_users (email, name, oauth_provider, oauth_id)
VALUES ('test@atlarix.com', 'Test User', 'google', 'test-123')
RETURNING *;

-- Create free subscription
WITH test_user AS (
    SELECT id FROM atlarix_users WHERE email = 'test@atlarix.com'
)
INSERT INTO atlarix_subscriptions (user_id, plan_type, status)
SELECT id, 'free', 'active' FROM test_user;
```

## Rollback

To completely remove Atlarix tables:

```sql
DROP TABLE IF EXISTS atlarix_webhook_logs CASCADE;
DROP TABLE IF EXISTS atlarix_prompt_usage CASCADE;
DROP TABLE IF EXISTS atlarix_devices CASCADE;
DROP TABLE IF EXISTS atlarix_version_entitlements CASCADE;
DROP TABLE IF EXISTS atlarix_subscriptions CASCADE;
DROP TABLE IF EXISTS atlarix_users CASCADE;
DROP VIEW IF EXISTS atlarix_prompt_stats;
DROP VIEW IF EXISTS atlarix_active_users;
```
