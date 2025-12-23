# Database Setup - Fly.io Instructions

## Issue: Local Connection to Fly.io Database

The database URL uses `.flycast` (Fly.io internal network), which is only accessible from within Fly.io apps, not from your local machine.

## Solutions

### Option 1: Run Migration from Fly.io App (Recommended)

Since you have `norahlabs-api` already deployed on Fly.io, run the migration from there:

```bash
# SSH into your Fly.io app
fly ssh console -a norahlabs-api

# Install dependencies if needed
npm install pg

# Upload and run migration
cat database/setup_fresh.sql | psql "$DATABASE_URL"
```

### Option 2: Create Fly.io Proxy

Create a proxy to access the database from your local machine:

```bash
# Start proxy (keeps running in terminal)
fly proxy 5432 -a norahlabs-db

# In another terminal, run migration
DATABASE_URL="postgres://norahlabs_api:PQvFGsDqVOHf9b0@localhost:5432/norahlabs_api?sslmode=disable" \
node scripts/setup-db.js
```

### Option 3: Deploy Migration Script to Fly.io

Add to your `norahlabs-api` backend:

1. Copy `database/setup_fresh.sql` to backend
2. Create endpoint: `POST /api/admin/setup-database`
3. Run migration via API call

```javascript
// In your backend API
app.post('/api/admin/setup-database', async (req, res) => {
  const fs = require('fs');
  const { pool } = require('./db');
  
  const sql = fs.readFileSync('./migrations/setup_fresh.sql', 'utf8');
  
  try {
    await pool.query(sql);
    res.json({ success: true, message: 'Database setup complete' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

Then:
```bash
curl -X POST https://norahlabs-api.fly.dev/api/admin/setup-database
```

## Quick Setup (Option 2 Recommended for Now)

```bash
# Terminal 1: Start proxy
fly proxy 5432 -a norahlabs-db

# Terminal 2: Run setup
DATABASE_URL="postgres://norahlabs_api:PQvFGsDqVOHf9b0@localhost:5432/norahlabs_api?sslmode=disable" \
npm run db:setup
```

## After Setup

Once database is created, you'll need to:

1. ✅ Update backend API to add auth endpoints
2. ✅ Configure OAuth (Google, GitHub)
3. ✅ Setup Lemon Squeezy webhooks
4. ✅ Test authentication flow

Let me know which option you'd like to use!
