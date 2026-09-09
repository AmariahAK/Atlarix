const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

async function setupDatabase() {
  console.log("🔄 Setting up fresh Atlarix database...");
  console.log("⚠️  WARNING: This will DROP ALL existing tables!\n");

  const sqlPath = path.join(__dirname, "../database/setup_fresh.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  try {
    // Execute the setup script
    await pool.query(sql);

    console.log("✅ Database setup completed successfully!\n");
    console.log("📊 Created tables:");
    console.log("  ✓ atlarix_users");
    console.log("  ✓ atlarix_subscriptions");
    console.log("  ✓ atlarix_version_entitlements");
    console.log("  ✓ atlarix_devices");
    console.log("  ✓ atlarix_prompt_usage");
    console.log("  ✓ atlarix_webhook_logs\n");

    // Verify tables were created
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name LIKE 'atlarix_%'
      ORDER BY table_name
    `);

    console.log("📋 Verified tables in database:");
    result.rows.forEach((row) => {
      console.log(`  ✓ ${row.table_name}`);
    });
    console.log("\n✅ All done! Database is ready for Atlarix.");
  } catch (error) {
    console.error("❌ Database setup failed:");
    console.error(`   ${error.message}\n`);

    if (error.message.includes("permission denied")) {
      console.log(
        "💡 Tip: Make sure your database user has CREATE permissions.",
      );
    } else if (error.message.includes("does not exist")) {
      console.log("💡 Tip: Check your DATABASE_URL in .env file.");
    }

    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  setupDatabase();
}

module.exports = { setupDatabase };
