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
import { columnExists, tableExists } from "./migration_seed_verification";
import {
  isPlaintextApiKeyInDb,
  serializeApiKeyForDb,
} from "@/lib/security/db-secrets";

const logger = log.scope("db");

/** Minimum tables after baseline migrations; extend if core IPC assumes new tables. */
const REQUIRED_CORE_TABLES = [
  "chat_sessions",
  "session_messages",
  "apps",
  "language_model_providers",
  "language_models",
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

      const drizzleDb = drizzle(sqlite, { schema });

      logger.log("[Migrations] Applying embedded SQL bundle (Vite ?raw, no drizzle/ path).");
      applyEmbeddedSqlMigrations(sqlite);

      try { ensureSessionCoreTablesIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring chat_sessions / session_messages tables (non-fatal):", error);
      }
      // These use IF NOT EXISTS or check sqlite_master first, so they are no-ops after a clean migrate().
      try { ensureChatCoreTablesIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring chats / messages tables (non-fatal):", error);
      }
      try { ensureMcpBaseTablesIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring mcp_servers / mcp_tool_consents tables (non-fatal):", error);
      }
      try { ensureAppsRemoteColumnsIfNeeded(sqlite); } catch (error) {
        logger.warn("[Schema Fix] apps remote columns:", error);
      }
      try { ensureMcpOAuthColumnsIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring mcp_servers OAuth columns (non-fatal):", error);
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
      try { ensureSessionMessagePlanColumnsIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring session_messages plan columns (non-fatal):", error);
      }
      try { ensureMessagesModelContentColumnIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring messages.model_content column (non-fatal):", error);
      }
      try { ensureMessagesPasteAttachmentsColumnIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring messages.paste_attachments column (non-fatal):", error);
      }
      try { migratePlaintextApiKeysIfNeeded(sqlite); } catch (error) {
        logger.error("Error migrating plaintext API keys (non-fatal):", error);
      }
      try { ensureMessagesFileAttachmentsColumnIfNeeded(sqlite); } catch (error) {
        logger.error("Error ensuring messages.file_attachments column (non-fatal):", error);
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

/** No-op recreate of legacy chats/messages — workspace sessions are created by migrations. */
function ensureSessionCoreTablesIfNeeded(_sqlite: Database.Database): void {
  /* migrations 0036+ create chat_sessions / session_messages */
}

function ensureChatCoreTablesIfNeeded(_sqlite: Database.Database): void {
  /* legacy chats/messages removed in migration 0058 */
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
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN scope TEXT NOT NULL DEFAULT 'workspace'");
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

function ensureMcpOAuthColumnsIfNeeded(sqlite: Database.Database): void {
  const tableExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_servers'")
    .get();
  if (!tableExists) return;

  const columns = sqlite.prepare("PRAGMA table_info(mcp_servers)").all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);

  if (!has("auth_type")) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none'");
    logger.log("[Schema Fix] mcp_servers: added auth_type column");
  }
  if (!has("oauth_tokens_json")) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_tokens_json TEXT");
    logger.log("[Schema Fix] mcp_servers: added oauth_tokens_json column");
  }
  if (!has("oauth_client_json")) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_client_json TEXT");
    logger.log("[Schema Fix] mcp_servers: added oauth_client_json column");
  }
  if (!has("oauth_discovery_json")) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_discovery_json TEXT");
    logger.log("[Schema Fix] mcp_servers: added oauth_discovery_json column");
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
function ensureMessagesModelContentColumnIfNeeded(sqlite: Database.Database): void {
  if (!tableExists(sqlite, "messages")) return;
  if (!columnExists(sqlite, "messages", "model_content")) {
    logger.log("[Schema Fix] Adding messages.model_content (0052_message_model_content)");
    sqlite.exec("ALTER TABLE messages ADD COLUMN model_content text");
  }
}

function ensureMessagesPasteAttachmentsColumnIfNeeded(sqlite: Database.Database): void {
  if (!tableExists(sqlite, "messages")) return;
  if (!columnExists(sqlite, "messages", "paste_attachments")) {
    logger.log("[Schema Fix] Adding messages.paste_attachments (0053_message_paste_attachments)");
    sqlite.exec("ALTER TABLE messages ADD COLUMN paste_attachments text");
  }
}

function ensureMessagesFileAttachmentsColumnIfNeeded(sqlite: Database.Database): void {
  if (!tableExists(sqlite, "messages")) return;
  if (!columnExists(sqlite, "messages", "file_attachments")) {
    logger.log("[Schema Fix] Adding messages.file_attachments (0054_message_file_attachments)");
    sqlite.exec("ALTER TABLE messages ADD COLUMN file_attachments text");
  }
}

function ensureSessionMessagePlanColumnsIfNeeded(sqlite: Database.Database): void {
  const hasSessionMessages = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_messages'")
    .get();
  if (!hasSessionMessages) return;

  if (!columnExists(sqlite, "session_messages", "kind")) {
    logger.log("[Schema Fix] Adding session_messages.kind (0048_session_plan_artifacts)");
    sqlite.exec(
      "ALTER TABLE session_messages ADD COLUMN kind text NOT NULL DEFAULT 'message'",
    );
  }
  if (!columnExists(sqlite, "session_messages", "plan_status")) {
    logger.log("[Schema Fix] Adding session_messages.plan_status (0048_session_plan_artifacts)");
    sqlite.exec("ALTER TABLE session_messages ADD COLUMN plan_status text");
  }
  if (!columnExists(sqlite, "session_messages", "model_content")) {
    logger.log("[Schema Fix] Adding session_messages.model_content (0055_session_message_attachments)");
    sqlite.exec("ALTER TABLE session_messages ADD COLUMN model_content text");
  }
  if (!columnExists(sqlite, "session_messages", "paste_attachments")) {
    logger.log("[Schema Fix] Adding session_messages.paste_attachments (0055_session_message_attachments)");
    sqlite.exec("ALTER TABLE session_messages ADD COLUMN paste_attachments text");
  }
  if (!columnExists(sqlite, "session_messages", "file_attachments")) {
    logger.log("[Schema Fix] Adding session_messages.file_attachments (0055_session_message_attachments)");
    sqlite.exec("ALTER TABLE session_messages ADD COLUMN file_attachments text");
  }
  if (!columnExists(sqlite, "session_messages", "status")) {
    logger.log("[Schema Fix] Adding session_messages.status (interrupted-turn recovery)");
    sqlite.exec(
      "ALTER TABLE session_messages ADD COLUMN status text NOT NULL DEFAULT 'complete'",
    );
  }
}

function ensureAppsRemoteColumnsIfNeeded(sqlite: Database.Database): void {
  if (!columnExists(sqlite, "apps", "last_opened_at")) {
    sqlite.exec("ALTER TABLE apps ADD COLUMN last_opened_at INTEGER");
  }
  if (!columnExists(sqlite, "apps", "workspace_kind")) {
    sqlite.exec("ALTER TABLE apps ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'local'");
  }
  if (!columnExists(sqlite, "apps", "remote_connection")) {
    sqlite.exec("ALTER TABLE apps ADD COLUMN remote_connection TEXT");
  }
}

/**
 * One-time: re-encrypt legacy plaintext api_key values in provider_api_keys and mcp_servers.
 */
function migratePlaintextApiKeysIfNeeded(sqlite: Database.Database): void {
  let migrated = 0;

  const providerTable = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_api_keys'",
    )
    .get();
  if (providerTable) {
    const rows = sqlite
      .prepare("SELECT id, api_key FROM provider_api_keys WHERE api_key IS NOT NULL")
      .all() as Array<{ id: number; api_key: string }>;
    const update = sqlite.prepare(
      "UPDATE provider_api_keys SET api_key = ? WHERE id = ?",
    );
    for (const row of rows) {
      if (isPlaintextApiKeyInDb(row.api_key)) {
        update.run(serializeApiKeyForDb(row.api_key), row.id);
        migrated += 1;
      }
    }
  }

  const mcpTable = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_servers'",
    )
    .get();
  if (mcpTable) {
    const rows = sqlite
      .prepare("SELECT id, api_key FROM mcp_servers WHERE api_key IS NOT NULL")
      .all() as Array<{ id: number; api_key: string }>;
    const update = sqlite.prepare("UPDATE mcp_servers SET api_key = ? WHERE id = ?");
    for (const row of rows) {
      if (isPlaintextApiKeyInDb(row.api_key)) {
        update.run(serializeApiKeyForDb(row.api_key), row.id);
        migrated += 1;
      }
    }
  }

  if (migrated > 0) {
    logger.log(`[DB] Encrypted ${migrated} legacy plaintext API key(s)`);
  }
}

/**
// Pass 7: ensurePivotTablesIfNeeded removed (PIVOT subsystem deleted; migration 0043 drops tables).

/**
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
