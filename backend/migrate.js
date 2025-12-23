/**
 * Database Migration Script
 * Runs setup_fresh.sql on atlarix-db
 */

import pg from 'pg';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
    console.log('🔄 Running Atlarix database migration...\n');

    const sqlPath = join(__dirname, '../database/setup_fresh.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    try {
        await pool.query(sql);

        console.log('✅ Migration completed!\n');
        console.log('Created tables:');
        console.log('  ✓ atlarix_users');
        console.log('  ✓ atlarix_subscriptions');
        console.log('  ✓ atlarix_version_entitlements');
        console.log('  ✓ atlarix_devices');
        console.log('  ✓ atlarix_prompt_usage');
        console.log('  ✓ atlarix_webhook_logs');

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

migrate();
