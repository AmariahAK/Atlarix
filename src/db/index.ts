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

  // PRE-MIGRATION FIX: Ensure mcp_servers has scope and app_id (avoids "no such column: scope")
  try {
    fixMcpServersSchemaIfNeeded(sqlite);
  } catch (error) {
    logger.error("Error fixing mcp_servers schema (non-fatal, continuing):", error);
  }

  // PRE-MIGRATION FIX: Ensure blueprints table exists (avoids "no such table: blueprints")
  try {
    ensureBlueprintsTableIfNeeded(sqlite);
  } catch (error) {
    logger.error("Error ensuring blueprints table (non-fatal, continuing):", error);
  }

  _db = drizzle(sqlite, { schema });

  try {
    // In dev builds (Vite/Electron), __dirname often points at ".vite/build",
    // so "..../drizzle" does not exist. Prefer the project-root drizzle folder
    // when available, with a fallback to the bundled path.
    const candidateFolders = [
      // Project root (when running from source)
      path.join(process.cwd(), "drizzle"),
      // Bundled path (packaged app)
      path.join(__dirname, "..", "..", "drizzle"),
    ];

    const migrationsFolder = candidateFolders.find((folder) =>
      fs.existsSync(folder),
    );

    if (!migrationsFolder) {
      logger.error(
        "Migrations folder not found. Tried:",
        candidateFolders.join(", "),
      );
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
 * Ensure mcp_servers has scope and app_id columns (for workspace MCP).
 * Fixes "SqliteError: no such column: scope" when migration 0026 wasn't applied.
 */
function fixMcpServersSchemaIfNeeded(sqlite: Database.Database): void {
  const tableExists = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_servers'"
  ).get();
  if (!tableExists) {
    return;
  }
  const columns = sqlite.prepare("PRAGMA table_info(mcp_servers)").all() as Array<{ name: string }>;
  const hasScope = columns.some((c) => c.name === "scope");
  const hasAppId = columns.some((c) => c.name === "app_id");
  if (hasScope && hasAppId) {
    return;
  }
  if (!hasScope) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'");
    logger.log("[Schema Fix] mcp_servers: added scope column");
  }
  if (!hasAppId) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN app_id INTEGER");
    logger.log("[Schema Fix] mcp_servers: added app_id column");
  }
}

/**
 * Ensure blueprints table exists (Phase 7 Additive Blueprint).
 * Fixes "SqliteError: no such table: blueprints" when migration 0028 wasn't applied.
 */
function ensureBlueprintsTableIfNeeded(sqlite: Database.Database): void {
  const tableExists = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='blueprints'"
  ).get();
  if (tableExists) {
    return;
  }
  logger.log("[Schema Fix] Creating blueprints table");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS blueprints (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      workspace_id integer NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      content text NOT NULL,
      updated_at integer DEFAULT (unixepoch()) NOT NULL
    )
  `);
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS blueprints_workspace_unique ON blueprints (workspace_id)");
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
