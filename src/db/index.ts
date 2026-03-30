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
import crypto from "node:crypto";
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

  // PRE-MIGRATION FIX: Create MCP tables if missing (migration 0012 baseline).
  // When __drizzle_migrations was seeded with all hashes, migrate() can skip every file — including 0012 —
  // leaving mcp_servers absent while the app expects it (mcp:list-servers).
  try {
    ensureMcpBaseTablesIfNeeded(sqlite);
  } catch (error) {
    logger.error("Error ensuring mcp_servers / mcp_tool_consents tables (non-fatal, continuing):", error);
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

  // PRE-MIGRATION FIX: Ensure PIVOT tables exist (pivot_nodes, pivot_edges, pivot_containers, pivot_beacons, blueprint_snapshots)
  try {
    ensurePivotTablesIfNeeded(sqlite);
  } catch (error) {
    logger.error("Error ensuring PIVOT tables (non-fatal, continuing):", error);
  }

  // v5.0: Ensure project_snapshots / project_memory (Section 2)
  try {
    ensureProjectMemoryTablesIfNeeded(sqlite);
  } catch (error) {
    logger.error("Error ensuring project memory tables (non-fatal, continuing):", error);
  }

  // v3.6: Ensure review_patterns table (lightning review memory)
  try {
    ensureReviewPatternsTableIfNeeded(sqlite);
  } catch (error) {
    logger.error("Error ensuring review_patterns table (non-fatal, continuing):", error);
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
      // If apps table already exists but __drizzle_migrations is empty/missing,
      // seed the migrations table so Drizzle skips already-applied migrations.
      seedDrizzleMigrationsIfNeeded(sqlite, migrationsFolder);
      logger.log("Running migrations from:", migrationsFolder);
      migrate(_db, { migrationsFolder });
    }
  } catch (error) {
    logger.error("Migration error:", error);
  }

  return _db as any;
}

/**
 * If the apps table already exists but __drizzle_migrations is empty or missing,
 * seed the migrations table with all journal entries (using file hash and when)
 * so that migrate() skips already-applied migrations and does not fail on CREATE TABLE apps.
 */
function seedDrizzleMigrationsIfNeeded(
  sqlite: Database.Database,
  migrationsFolder: string,
): void {
  const appsExists = sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='apps'",
  ).get();
  if (!appsExists) return;

  const tableName = "__drizzle_migrations";
  const createTable = sqlite.prepare(
    `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)`,
  );
  createTable.run();

  const count = (sqlite.prepare(`SELECT COUNT(*) as c FROM ${tableName}`).get() as { c: number })?.c ?? 0;
  if (count > 0) return;

  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) return;

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries?: Array<{ tag: string; when: number }>;
  };
  const entries = journal?.entries ?? [];
  if (entries.length === 0) return;

  logger.log("[Schema Fix] Seeding __drizzle_migrations so existing DB is not re-migrated.");
  const insert = sqlite.prepare(
    `INSERT INTO ${tableName} (hash, created_at) VALUES (?, ?)`,
  );
  for (const entry of entries) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) continue;
    const query = fs.readFileSync(sqlPath, "utf8");
    const hash = crypto.createHash("sha256").update(query).digest("hex");
    insert.run(hash, entry.when);
  }
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
 * v3.6: Ensure review_patterns table exists (lightning review memory).
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
      blueprint_json TEXT NOT NULL,
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

/**
 * Ensure PIVOT tables exist (Full PIVOT implementation).
 * Creates pivot_nodes, pivot_edges, pivot_containers, pivot_beacons, blueprint_snapshots if missing.
 */
function ensurePivotTablesIfNeeded(sqlite: Database.Database): void {
  const tables = [
    "pivot_nodes",
    "pivot_edges",
    "pivot_containers",
    "pivot_beacons",
    "blueprint_snapshots",
  ];
  for (const table of tables) {
    const exists = sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    if (exists) continue;
    logger.log("[Schema Fix] Creating PIVOT table:", table);
  }
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pivot_nodes'").get()) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS pivot_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        workspace_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        file_path TEXT NOT NULL,
        range_start INTEGER,
        range_end INTEGER,
        metadata TEXT
      )
    `);
    sqlite.exec("CREATE INDEX IF NOT EXISTS pivot_nodes_workspace_idx ON pivot_nodes (workspace_id)");
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS pivot_nodes_workspace_external_unique ON pivot_nodes (workspace_id, external_id)");
  }
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pivot_edges'").get()) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS pivot_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        workspace_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        metadata TEXT
      )
    `);
    sqlite.exec("CREATE INDEX IF NOT EXISTS pivot_edges_workspace_idx ON pivot_edges (workspace_id)");
  }
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pivot_containers'").get()) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS pivot_containers (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        intent TEXT,
        position TEXT,
        created_at INTEGER DEFAULT (unixepoch()) NOT NULL
      )
    `);
  }
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pivot_beacons'").get()) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS pivot_beacons (
        id TEXT PRIMARY KEY NOT NULL,
        container_id TEXT NOT NULL REFERENCES pivot_containers(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        description TEXT,
        file_path TEXT,
        position TEXT
      )
    `);
  }
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blueprint_snapshots'").get()) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS blueprint_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        workspace_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        snapshot_at INTEGER DEFAULT (unixepoch()) NOT NULL,
        blueprint_json TEXT NOT NULL,
        source TEXT NOT NULL
      )
    `);
    sqlite.exec("CREATE INDEX IF NOT EXISTS blueprint_snapshots_workspace_idx ON blueprint_snapshots (workspace_id)");
  }
}

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
