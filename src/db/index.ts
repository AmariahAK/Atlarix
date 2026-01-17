// db.ts
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import { getAtlarixAppPath, getUserDataPath } from "../paths/paths";
import log from "electron-log";

const logger = log.scope("db");

// Database connection factory
let _db: ReturnType<typeof drizzle> | null = null;

/**
 * Get the database path based on the current environment
 * 
 * DATABASE LOCATIONS:
 * - Development (npm run dev): ./userData/sqlite.db (relative to project root)
 * - Production (packaged app): ~/Library/Application Support/Atlarix/sqlite.db (macOS)
 *                              %APPDATA%/Atlarix/sqlite.db (Windows)
 *                              ~/.config/Atlarix/sqlite.db (Linux)
 */
export function getDatabasePath(): string {
  return path.join(getUserDataPath(), "sqlite.db");
}

/**
 * Initialize the database connection
 */
export function initializeDatabase(): BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
} {
  if (_db) return _db as any;

  const dbPath = getDatabasePath();
  logger.log("Initializing database at:", dbPath);

  // Check if the database file exists and remove it if it has issues
  try {
    if (fs.existsSync(dbPath)) {
      const stats = fs.statSync(dbPath);
      if (stats.size < 100) {
        logger.log("Database file exists but may be corrupted. Removing it...");
        fs.unlinkSync(dbPath);
      }
    }
  } catch (error) {
    logger.error("Error checking database file:", error);
  }

  fs.mkdirSync(getUserDataPath(), { recursive: true });
  fs.mkdirSync(getAtlarixAppPath("."), { recursive: true });

  const sqlite = new Database(dbPath, { timeout: 10000 });
  sqlite.pragma("foreign_keys = ON");

  // PRE-MIGRATION FIX: Check and fix prompts table schema before Drizzle migrations
  // This handles the case where old schema (with 'title') exists but needs 'type' and 'workspace_id'
  try {
    fixPromptsSchemaIfNeeded(sqlite);
  } catch (error) {
    logger.error("Error fixing prompts schema (non-fatal, continuing):", error);
  }

  _db = drizzle(sqlite, { schema });

  try {
    const migrationsFolder = path.join(__dirname, "..", "..", "drizzle");
    if (!fs.existsSync(migrationsFolder)) {
      logger.error("Migrations folder not found:", migrationsFolder);
    } else {
      logger.log("Running migrations from:", migrationsFolder);
      migrate(_db, { migrationsFolder });
    }
  } catch (error) {
    logger.error("Migration error:", error);
  }

  return _db as any;
}

/**
 * Fix prompts table schema if it has the old structure
 * OLD: id, title, description, content, created_at, updated_at
 * NEW: id, type, workspace_id, content, created_at, updated_at
 */
function fixPromptsSchemaIfNeeded(sqlite: Database.Database): void {
  // Check if prompts table exists
  const tableExists = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='prompts'"
  ).get();

  if (!tableExists) {
    logger.log("[Schema Fix] Prompts table doesn't exist, will be created by migrations");
    return;
  }

  // Check if 'type' column exists (new schema indicator)
  const columns = sqlite.prepare("PRAGMA table_info(prompts)").all() as Array<{ name: string }>;
  const hasTypeColumn = columns.some(col => col.name === 'type');
  const hasTitleColumn = columns.some(col => col.name === 'title');

  if (hasTypeColumn) {
    logger.log("[Schema Fix] Prompts table already has correct schema (has 'type' column)");
    return;
  }

  if (!hasTitleColumn) {
    logger.log("[Schema Fix] Prompts table has unknown schema, skipping fix");
    return;
  }

  // Old schema detected - migrate to new schema
  logger.log("[Schema Fix] Detected OLD prompts schema (has 'title'), migrating to new schema...");

  // Begin transaction for safety
  const transaction = sqlite.transaction(() => {
    // 1. Rename old table
    sqlite.exec("ALTER TABLE prompts RENAME TO prompts_old_backup");

    // 2. Create new table with correct schema
    sqlite.exec(`
      CREATE TABLE prompts (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        type text NOT NULL DEFAULT 'global',
        workspace_id integer,
        content text NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )
    `);

    // 3. Create unique index
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS prompts_workspace_unique ON prompts (workspace_id)");

    // 4. Copy data from old table (content becomes global prompts)
    sqlite.exec(`
      INSERT INTO prompts (id, type, workspace_id, content, created_at, updated_at)
      SELECT id, 'global', NULL, content, created_at, updated_at
      FROM prompts_old_backup
    `);

    // 5. Drop old table
    sqlite.exec("DROP TABLE prompts_old_backup");
  });

  transaction();
  logger.log("[Schema Fix] Successfully migrated prompts table to new schema!");
}

/**
 * Get the database instance (throws if not initialized)
 */
export function getDb(): BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
} {
  if (!_db) {
    throw new Error(
      "Database not initialized. Call initializeDatabase() first.",
    );
  }
  return _db as any;
}

export const db = new Proxy({} as any, {
  get(target, prop) {
    const database = getDb();
    return database[prop as keyof typeof database];
  },
}) as BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};
