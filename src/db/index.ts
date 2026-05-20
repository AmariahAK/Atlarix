// db.ts
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import path from "node:path";
import fs from "node:fs";
import { getAtlarixAppPath, getUserDataPath } from "../paths/paths";
import log from "electron-log";
import {
  applyEmbeddedSqlMigrations,
  countAtlarixMigrations,
  expectedBundledMigrationCount,
  UnknownDrizzleMigrationHashError,
} from "./migrate_atlarix";

const logger = log.scope("db");

/** Minimum tables after baseline migrations; extend if core IPC assumes new tables. */
const REQUIRED_CORE_TABLES = [
  "apps",
  "chats",
  "messages",
  "language_model_providers",
  "language_models",
  "prompts",
] as const;

function isCoreSchemaComplete(sqlite: Database.Database): boolean {
  const stmt = sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  );
  return REQUIRED_CORE_TABLES.every((name) => !!stmt.get(name));
}

function isMigrationStateConsistent(sqlite: Database.Database): boolean {
  const hasTable = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='__atlarix_migrations'",
    )
    .get();
  if (!hasTable) {
    return false;
  }
  const n = countAtlarixMigrations(sqlite);
  const expected = expectedBundledMigrationCount();
  if (n !== expected) {
    logger.warn(
      `[DB] __atlarix_migrations count ${n} !== expected ${expected} (embedded bundle).`,
    );
    return false;
  }
  return true;
}

function closeSqliteSilently(sqlite: Database.Database): void {
  try {
    sqlite.close();
  } catch (e) {
    logger.warn("[DB] Error closing SQLite (non-fatal):", e);
  }
}

function deleteSqliteDbFiles(dbPath: string): void {
  for (const extra of ["", "-wal", "-shm"] as const) {
    const p = extra === "" ? dbPath : dbPath + extra;
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        logger.log("[DB] Removed:", p);
      }
    } catch (e) {
      logger.warn("[DB] Could not remove file:", p, e);
    }
  }
}

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
 * Initialize the database connection. On failure with bundled migrations available,
 * deletes local sqlite.db (+ wal/shm) once and retries so partial bootstrap-only DBs recover.
 */
export function initializeDatabase(): BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
} {
  if (_db) return _db as any;

  const dbPath = getDatabasePath();
  logger.log("Initializing database at:", dbPath);

  fs.mkdirSync(getUserDataPath(), { recursive: true });
  fs.mkdirSync(getAtlarixAppPath("."), { recursive: true });

  const maxAttempts = 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let sqlite: Database.Database | null = null;
    try {
      if (attempt > 0) {
        logger.warn(
          "[DB] Retrying database initialization after removing incomplete local DB (attempt 2/2)...",
        );
      }

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

      sqlite = new Database(dbPath, { timeout: 10000 });
      sqlite.pragma("foreign_keys = ON");

      // PRE-MIGRATION: Only schema fixes that must run before migrate() (column renames, etc.)
      try { fixPromptsSchemaIfNeeded(sqlite); } catch (error) {
        logger.error("Error fixing prompts schema (non-fatal, continuing):", error);
      }

      const drizzleDb = drizzle(sqlite, { schema });

      logger.log("[Migrations] Applying embedded SQL bundle (Vite ?raw, no drizzle/ path).");
      applyEmbeddedSqlMigrations(sqlite);

      // POST-MIGRATION safety nets: create tables that migrations may have skipped
      // (legacy DBs with seeded journals, partial upgrades, etc.)
      // These use IF NOT EXISTS or check sqlite_master first, so they are no-ops after a clean migrate().
      try { ensureChatCoreTablesIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring chats / messages tables (non-fatal):", error);
      }
      try { ensureMcpBaseTablesIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring mcp_servers / mcp_tool_consents tables (non-fatal):", error);
      }
      try { fixMcpServersSchemaIfNeeded(sqlite); } catch (error) {
        logger.error("Error fixing mcp_servers schema (non-fatal):", error);
      }
      // Pass 7: Blueprint + PIVOT table ensure-fns removed; migration 0043 drops the tables.
      try { ensureProjectMemoryTablesIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring project memory tables (non-fatal):", error);
      }
      try { ensureReviewPatternsTableIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring review_patterns table (non-fatal):", error);
      }

      if (!isCoreSchemaComplete(sqlite)) {
        throw new Error(
          `SQLite core schema incomplete (missing one of: ${REQUIRED_CORE_TABLES.join(", ")}).`,
        );
      }
      if (!isMigrationStateConsistent(sqlite)) {
        throw new Error(
          "SQLite __atlarix_migrations is missing or does not match embedded migration count after apply.",
        );
      }

      _db = drizzleDb;
      sqlite = null;
      return _db as any;
    } catch (error) {
      logger.error(`[DB] Initialization attempt ${attempt + 1} failed:`, error);
      if (sqlite) {
        closeSqliteSilently(sqlite);
        sqlite = null;
      }

      const unknownHash =
        error instanceof UnknownDrizzleMigrationHashError;
      const canRetry =
        attempt < maxAttempts - 1 && !unknownHash;

      if (canRetry) {
        logger.warn(
          "[DB] Deleting local sqlite.db (and -wal/-shm) and retrying once — embedded migrations available (skipped on unknown Drizzle hash).",
        );
        deleteSqliteDbFiles(dbPath);
        continue;
      }

      throw error;
    }
  }

  throw new Error("Database initialization failed after retries.");
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
 * Create chats + messages if missing (0000 / 0022 / 0029 baseline).
 * When the migration ledger marks all migrations applied without running SQL, chats can be missing while apps exists (get-chats / search-chats).
 */
function ensureChatCoreTablesIfNeeded(sqlite: Database.Database): void {
  const appsExists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='apps'")
    .get();
  if (!appsExists) {
    return;
  }

  const hasChats = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chats'")
    .get();
  if (!hasChats) {
    logger.log("[Schema Fix] Creating chats table (0000/0022/0029 baseline)");
    sqlite.exec(`
      CREATE TABLE chats (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        app_id integer,
        title text,
        initial_commit_hash text,
        has_answered_questions integer NOT NULL DEFAULT 0,
        last_used_at integer DEFAULT (unixepoch()) NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (app_id) REFERENCES apps(id) ON UPDATE no action ON DELETE cascade
      )
    `);
  }

  const hasMessages = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'")
    .get();
  if (!hasMessages) {
    logger.log("[Schema Fix] Creating messages table (0000+alters baseline)");
    sqlite.exec(`
      CREATE TABLE messages (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        chat_id integer NOT NULL,
        role text NOT NULL,
        content text NOT NULL,
        approval_state text,
        source_commit_hash text,
        commit_hash text,
        request_id text,
        max_tokens_used integer,
        exchange_index integer DEFAULT 0,
        snapshot_id integer,
        files_written text,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON UPDATE no action ON DELETE cascade
      )
    `);
  }
}

/**
 * Create mcp_servers + mcp_tool_consents if missing (matches drizzle/0012_bouncy_fenris.sql).
 * Required when migrations were skipped after journal seeding but the app still uses MCP IPC.
 */
function ensureMcpBaseTablesIfNeeded(sqlite: Database.Database): void {
  const hasServers = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_servers'")
    .get();
  if (!hasServers) {
    logger.log("[Schema Fix] Creating mcp_servers table (0012 baseline)");
    sqlite.exec(`
      CREATE TABLE mcp_servers (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        name text NOT NULL,
        transport text NOT NULL,
        command text,
        args text,
        env_json text,
        url text,
        enabled integer DEFAULT 0 NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )
    `);
  }
  const hasConsents = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_tool_consents'")
    .get();
  if (!hasConsents) {
    logger.log("[Schema Fix] Creating mcp_tool_consents table (0012 baseline)");
    sqlite.exec(`
      CREATE TABLE mcp_tool_consents (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        server_id integer NOT NULL,
        tool_name text NOT NULL,
        consent text DEFAULT 'ask' NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON UPDATE no action ON DELETE cascade
      )
    `);
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS uniq_mcp_consent ON mcp_tool_consents (server_id, tool_name)",
    );
  }
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
  // Pass 7: from_registry / registry_id columns track marketplace installs.
  const hasFromRegistry = columns.some((c) => c.name === "from_registry");
  const hasRegistryId = columns.some((c) => c.name === "registry_id");
  const hasApiKey = columns.some((c) => c.name === "api_key");
  if (hasScope && hasAppId && hasFromRegistry && hasRegistryId && hasApiKey) {
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
  if (!hasFromRegistry) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN from_registry INTEGER NOT NULL DEFAULT 0");
    logger.log("[Schema Fix] mcp_servers: added from_registry column");
  }
  if (!hasRegistryId) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN registry_id TEXT");
    logger.log("[Schema Fix] mcp_servers: added registry_id column");
  }
  if (!hasApiKey) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN api_key TEXT");
    logger.log("[Schema Fix] mcp_servers: added api_key column");
  }
}

// Pass 7: ensureBlueprintsTableIfNeeded removed (Blueprint subsystem deleted).

/**
 * v3.6: Ensure review_patterns table exists (lightning review memory).
 *
 * Pass 7: project_snapshots no longer carries `blueprint_json`; migration 0043
 * drops that column. Newly-created tables omit it as well.
 */
function ensureProjectMemoryTablesIfNeeded(sqlite: Database.Database): void {
  if (
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_snapshots'").get()
  ) {
    return;
  }
  logger.log("[Schema Fix] Creating project_snapshots / project_memory tables");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      workspace_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      plan_md TEXT,
      diagram_mermaid TEXT,
      git_commit_hash TEXT,
      session_summary TEXT,
      trigger TEXT NOT NULL
    )
  `);
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS project_snapshots_workspace_created_idx ON project_snapshots (workspace_id, created_at)",
  );
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_memory (
      workspace_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      PRIMARY KEY (workspace_id, key)
    )
  `);
  sqlite.exec("CREATE INDEX IF NOT EXISTS project_memory_workspace_idx ON project_memory (workspace_id)");
}

function ensureReviewPatternsTableIfNeeded(sqlite: Database.Database): void {
  const tableExists = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='review_patterns'"
  ).get();
  if (tableExists) return;
  logger.log("[Schema Fix] Creating review_patterns table");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS review_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      workspace_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      issue_rule TEXT NOT NULL,
      issue_context TEXT,
      fix_applied TEXT NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  sqlite.exec("CREATE INDEX IF NOT EXISTS review_patterns_workspace_idx ON review_patterns (workspace_id)");
}

// Pass 7: ensurePivotTablesIfNeeded removed (PIVOT subsystem deleted; migration 0043 drops tables).

/**
 * Whether the database has been initialized (safe to use from IPC handlers).
 */
export function isDbInitialized(): boolean {
  return _db !== null;
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
