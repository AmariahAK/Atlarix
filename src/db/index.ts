// db.ts
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getAtlarixAppPath, getUserDataPath } from "../paths/paths";
import log from "electron-log";
import {
  applyEmbeddedSqlMigrations,
  assertReadableByThisBuild,
  countAtlarixMigrations,
  DatabaseInUseForUpgradeError,
  assertNoOlderDesktopForUpgrade,
  markDesktopKeepsNewerDatabase,
  OlderDesktopAppError,
  DatabaseNewerThanClientError,
  pendingBundledMigrations,
  registerDatabaseClient,
  expectedBundledMigrationCount,
  unknownAppliedMigrations,
  UnknownDrizzleMigrationHashError,
} from "./migrate_atlarix";
import { columnExists, tableExists } from "./migration_seed_verification";
import {
  isPlaintextApiKeyInDb,
  serializeApiKeyForDb,
} from "@/lib/security/db-secrets";
import { groupDuplicateAppIds } from "@/lib/canonical-app-path";
import { LIVE_SESSIONS_TABLE, PEER_STALE_MS } from "@/lib/peers/peers";

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
  // Every migration THIS build ships must be applied. Extra rows are fine:
  // they are a newer build's (the desktop app and the CLI share this file and
  // update independently), and `assertReadableByThisBuild` has already decided
  // whether this build may read past them. Counting for EQUALITY here used to
  // fail an older build on a newer database, and the failure path below then
  // deleted the database — every chat, for a version skew.
  const unknown = unknownAppliedMigrations(sqlite).length;
  const n = countAtlarixMigrations(sqlite) - unknown;
  const expected = expectedBundledMigrationCount();
  if (n !== expected) {
    logger.warn(
      `[DB] __atlarix_migrations has ${n} of this build's ${expected} embedded migrations applied` +
        (unknown ? ` (plus ${unknown} from a newer build)` : "") +
        ".",
    );
    return false;
  }
  if (unknown) {
    logger.info(
      `[DB] Database carries ${unknown} migration(s) from a newer Atlarix build; readable by this one.`,
    );
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
/** Drops this process's row in __atlarix_clients (see registerDatabaseClient). */
let stopClientHeartbeat: (() => void) | null = null;

const PRE_MIGRATION_BACKUPS_KEPT = 3;

/**
 * A full copy of the database, taken before migrations run. Kept outside the
 * database folder's normal files, newest three only. Never fatal: a failed copy
 * is logged loudly, and the migration it would have protected still runs.
 */
function backupBeforeMigrating(sqlite: Database.Database, pending: number): void {
  const dir = path.join(getUserDataPath(), "backups", "before-update");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(
      dir,
      `sqlite-${new Date().toISOString().replace(/[:.]/g, "-")}.db`,
    );
    sqlite.prepare("VACUUM INTO ?").run(dest);
    logger.log(`[DB] Copied the database to ${dest} before ${pending} migration(s).`);
    const old = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("sqlite-") && f.endsWith(".db"))
      .sort()
      .slice(0, -PRE_MIGRATION_BACKUPS_KEPT);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  } catch (e) {
    logger.error("[DB] Could not copy the database before migrating (continuing):", e);
  }
}

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

  const releaseInitLock = takeInitLock(dbPath);
  try {
    return openAndMigrate(dbPath);
  } finally {
    releaseInitLock();
  }
}

/**
 * How long a process waits for another one's first open to finish. A first
 * open migrates an empty file; that takes well under a second, so this is
 * reached only if the holder hung, and then this one goes ahead anyway.
 */
const INIT_LOCK_WAIT_MS = 30_000;

/**
 * One process at a time opens and migrates the database. Two first opens at
 * once (the app and the CLI on a new profile) migrated the same empty file
 * together: one met "database is locked" or "table already exists", and its
 * retry deleted the file the other was still migrating, so both failed with
 * "disk I/O error" (A8, QA 2 of 3). The lock is a file beside the database
 * holding its owner's pid; one whose owner has ended is taken over.
 */
function takeInitLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.init-lock`;
  const deadline = Date.now() + INIT_LOCK_WAIT_MS;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return () => fs.rmSync(lockPath, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return () => {};
    }
    let said = "";
    let age = 0;
    try {
      said = fs.readFileSync(lockPath, "utf8").trim();
      age = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      continue; // released between the two calls: try again
    }
    // Empty: its owner created it and has not written its pid yet.
    const holder = Number(said);
    const ended = said ? !Number.isInteger(holder) || holder <= 0 || !pidAlive(holder) : age > 5_000;
    if (ended) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      logger.warn(`[DB] Process ${holder} has held the database's first-open lock for ${INIT_LOCK_WAIT_MS / 1000}s; opening anyway.`);
      return () => {};
    }
    Atomics.wait(wait, 0, 0, 50);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * "Locked", "busy" or an I/O error: another process has the file open. Never a
 * reason to delete it, whatever else failed.
 */
function isFileInUseError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = error instanceof Error ? error.message : String(error);
  return /^SQLITE_(BUSY|LOCKED|IOERR)/.test(code) || /database is locked|database is busy|disk I\/O error/i.test(message);
}

function openAndMigrate(dbPath: string): BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
} {
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
            logger.log(
              "Database file exists but may be corrupted. Removing it...",
            );
            fs.unlinkSync(dbPath);
          }
        }
      } catch (error) {
        logger.error("Error checking database file:", error);
      }

      sqlite = new Database(dbPath, { timeout: 10000 });
      sqlite.pragma("foreign_keys = ON");
      // WAL lets the desktop app and the CLI read and write the same file at
      // once (readers never block the writer). Persistent once set; a no-op if
      // another connection holds the database in a mode it cannot leave yet.
      sqlite.pragma("journal_mode = WAL");
      // Before migrating: an older build must not write into a schema a newer
      // build has declared it cannot read.
      assertReadableByThisBuild(sqlite);
      // And keep a copy of the data from before any migration runs. The file may
      // be shared with the other Atlarix program (app or CLI), so a migration
      // that goes wrong would take BOTH programs' history with it.
      const pending = pendingBundledMigrations(sqlite);
      // The CLI on the desktop's database: never upgrade one a 14.x desktop
      // still uses (that app deletes a database it finds newer). See
      // assertNoOlderDesktopForUpgrade.
      if (process.env.ATLARIX_DB_SHARED === "1") {
        assertNoOlderDesktopForUpgrade(sqlite, pending);
      }
      if (pending.length > 0 && isCoreSchemaComplete(sqlite)) {
        backupBeforeMigrating(sqlite, pending.length);
      }

      const drizzleDb = drizzle(sqlite, { schema });

      logger.log(
        "[Migrations] Applying embedded SQL bundle (Vite ?raw, no drizzle/ path).",
      );
      applyEmbeddedSqlMigrations(sqlite);

      try {
        ensureSessionCoreTablesIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring chat_sessions / session_messages tables (non-fatal):",
          error,
        );
      }
      // These use IF NOT EXISTS or check sqlite_master first, so they are no-ops after a clean migrate().
      try {
        ensureChatCoreTablesIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring chats / messages tables (non-fatal):",
          error,
        );
      }
      try {
        ensureMcpBaseTablesIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring mcp_servers / mcp_tool_consents tables (non-fatal):",
          error,
        );
      }
      try {
        ensureAppsRemoteColumnsIfNeeded(sqlite);
      } catch (error) {
        logger.warn("[Schema Fix] apps remote columns:", error);
      }
      try {
        ensureMcpOAuthColumnsIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring mcp_servers OAuth columns (non-fatal):",
          error,
        );
      }
      try {
        fixMcpServersSchemaIfNeeded(sqlite);
      } catch (error) {
        logger.error("Error fixing mcp_servers schema (non-fatal):", error);
      }
      // Pass 7: Blueprint + PIVOT table ensure-fns removed; migration 0043 drops the tables.
      try {
        ensureProjectMemoryTablesIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring project memory tables (non-fatal):",
          error,
        );
      }
      try {
        ensureReviewPatternsTableIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring review_patterns table (non-fatal):",
          error,
        );
      }
      try {
        ensureAutomationTablesIfNeeded(sqlite);
      } catch (error) {
        logger.error("Error ensuring automations tables (non-fatal):", error);
      }
      try {
        ensureSessionMessagePlanColumnsIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring session_messages plan columns (non-fatal):",
          error,
        );
      }
      try {
        ensureMessagesModelContentColumnIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring messages.model_content column (non-fatal):",
          error,
        );
      }
      try {
        ensureMessagesPasteAttachmentsColumnIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring messages.paste_attachments column (non-fatal):",
          error,
        );
      }
      try {
        migratePlaintextApiKeysIfNeeded(sqlite);
      } catch (error) {
        logger.error("Error migrating plaintext API keys (non-fatal):", error);
      }
      try {
        ensureMessagesFileAttachmentsColumnIfNeeded(sqlite);
      } catch (error) {
        logger.error(
          "Error ensuring messages.file_attachments column (non-fatal):",
          error,
        );
      }
      try {
        mergeDuplicateAppsByPathIfNeeded(sqlite);
      } catch (error) {
        logger.error("Error merging duplicate apps rows (non-fatal):", error);
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

      // The desktop app (not the CLI) records that it keeps a database a newer
      // build migrated, which is what lets the CLI upgrade it from now on.
      if (process.env.ATLARIX_DB_SHARED !== "1" && process.env.ATLARIX_SURFACE !== "cli") {
        try {
          markDesktopKeepsNewerDatabase(sqlite);
        } catch (error) {
          logger.warn("[DB] Could not record the desktop's skew-safe mark (non-fatal):", error);
        }
      }

      _db = drizzleDb;
      stopClientHeartbeat?.();
      stopClientHeartbeat = registerDatabaseClient(
        sqlite,
        process.env.ATLARIX_CLIENT_PROGRAM ?? "Atlarix app",
      );
      sqlite = null;
      return _db as any;
    } catch (error) {
      logger.error(`[DB] Initialization attempt ${attempt + 1} failed:`, error);
      if (sqlite) {
        closeSqliteSilently(sqlite);
        sqlite = null;
      }

      const unknownHash = error instanceof UnknownDrizzleMigrationHashError;
      const tooNew =
        error instanceof DatabaseNewerThanClientError ||
        error instanceof DatabaseInUseForUpgradeError ||
        error instanceof OlderDesktopAppError;
      // The CLI opens the DESKTOP's database. It must never be the program that
      // deletes someone's chat history, whatever went wrong.
      const shared = process.env.ATLARIX_DB_SHARED === "1";
      const canRetry =
        attempt < maxAttempts - 1 && !unknownHash && !tooNew && !shared && !isFileInUseError(error);

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
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_servers'",
    )
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
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_tool_consents'",
    )
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
  const tableExists = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_servers'",
    )
    .get();
  if (!tableExists) {
    return;
  }
  const columns = sqlite
    .prepare("PRAGMA table_info(mcp_servers)")
    .all() as Array<{ name: string }>;
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
    sqlite.exec(
      "ALTER TABLE mcp_servers ADD COLUMN scope TEXT NOT NULL DEFAULT 'workspace'",
    );
    logger.log("[Schema Fix] mcp_servers: added scope column");
  }
  if (!hasAppId) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN app_id INTEGER");
    logger.log("[Schema Fix] mcp_servers: added app_id column");
  }
  if (!hasFromRegistry) {
    sqlite.exec(
      "ALTER TABLE mcp_servers ADD COLUMN from_registry INTEGER NOT NULL DEFAULT 0",
    );
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
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_servers'",
    )
    .get();
  if (!tableExists) return;

  const columns = sqlite
    .prepare("PRAGMA table_info(mcp_servers)")
    .all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);

  if (!has("auth_type")) {
    sqlite.exec(
      "ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none'",
    );
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
    sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_snapshots'",
      )
      .get()
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
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS project_memory_workspace_idx ON project_memory (workspace_id)",
  );
}

function ensureReviewPatternsTableIfNeeded(sqlite: Database.Database): void {
  const tableExists = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='review_patterns'",
    )
    .get();
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
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS review_patterns_workspace_idx ON review_patterns (workspace_id)",
  );
}

/** Self-heal for 0066_automations on DBs whose migration ledger predates it. */
function ensureAutomationTablesIfNeeded(sqlite: Database.Database): void {
  if (!tableExists(sqlite, "automations")) {
    logger.log("[Schema Fix] Creating automations table (0066_automations)");
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id INTEGER REFERENCES apps(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT true,
        trigger TEXT NOT NULL,
        prompt TEXT NOT NULL,
        run_mode TEXT NOT NULL DEFAULT 'read-only',
        model TEXT,
        cursor TEXT,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  }
  if (!tableExists(sqlite, "automation_runs")) {
    logger.log(
      "[Schema Fix] Creating automation_runs table (0066_automations)",
    );
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY NOT NULL,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        summary TEXT,
        error TEXT,
        unread INTEGER NOT NULL DEFAULT true,
        archived INTEGER NOT NULL DEFAULT false,
        proposal_diff TEXT,
        proposal_files TEXT,
        proposal_applied_at INTEGER,
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        finished_at INTEGER
      )
    `);
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS automation_runs_automation_id_idx ON automation_runs (automation_id)",
    );
  }
  // 0067: trigger_context on runs (self-heal for DBs whose ledger predates it).
  if (
    tableExists(sqlite, "automation_runs") &&
    !columnExists(sqlite, "automation_runs", "trigger_context")
  ) {
    logger.log("[Schema Fix] Adding automation_runs.trigger_context (0067)");
    sqlite.exec("ALTER TABLE automation_runs ADD COLUMN trigger_context text");
  }
}

function ensureMessagesModelContentColumnIfNeeded(
  sqlite: Database.Database,
): void {
  if (!tableExists(sqlite, "messages")) return;
  if (!columnExists(sqlite, "messages", "model_content")) {
    logger.log(
      "[Schema Fix] Adding messages.model_content (0052_message_model_content)",
    );
    sqlite.exec("ALTER TABLE messages ADD COLUMN model_content text");
  }
}

function ensureMessagesPasteAttachmentsColumnIfNeeded(
  sqlite: Database.Database,
): void {
  if (!tableExists(sqlite, "messages")) return;
  if (!columnExists(sqlite, "messages", "paste_attachments")) {
    logger.log(
      "[Schema Fix] Adding messages.paste_attachments (0053_message_paste_attachments)",
    );
    sqlite.exec("ALTER TABLE messages ADD COLUMN paste_attachments text");
  }
}

function ensureMessagesFileAttachmentsColumnIfNeeded(
  sqlite: Database.Database,
): void {
  if (!tableExists(sqlite, "messages")) return;
  if (!columnExists(sqlite, "messages", "file_attachments")) {
    logger.log(
      "[Schema Fix] Adding messages.file_attachments (0054_message_file_attachments)",
    );
    sqlite.exec("ALTER TABLE messages ADD COLUMN file_attachments text");
  }
}

function ensureSessionMessagePlanColumnsIfNeeded(
  sqlite: Database.Database,
): void {
  const hasSessionMessages = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_messages'",
    )
    .get();
  if (!hasSessionMessages) return;

  if (!columnExists(sqlite, "session_messages", "kind")) {
    logger.log(
      "[Schema Fix] Adding session_messages.kind (0048_session_plan_artifacts)",
    );
    sqlite.exec(
      "ALTER TABLE session_messages ADD COLUMN kind text NOT NULL DEFAULT 'message'",
    );
  }
  if (!columnExists(sqlite, "session_messages", "plan_status")) {
    logger.log(
      "[Schema Fix] Adding session_messages.plan_status (0048_session_plan_artifacts)",
    );
    sqlite.exec("ALTER TABLE session_messages ADD COLUMN plan_status text");
  }
  if (!columnExists(sqlite, "session_messages", "model_content")) {
    logger.log(
      "[Schema Fix] Adding session_messages.model_content (0055_session_message_attachments)",
    );
    sqlite.exec("ALTER TABLE session_messages ADD COLUMN model_content text");
  }
  if (!columnExists(sqlite, "session_messages", "paste_attachments")) {
    logger.log(
      "[Schema Fix] Adding session_messages.paste_attachments (0055_session_message_attachments)",
    );
    sqlite.exec(
      "ALTER TABLE session_messages ADD COLUMN paste_attachments text",
    );
  }
  if (!columnExists(sqlite, "session_messages", "file_attachments")) {
    logger.log(
      "[Schema Fix] Adding session_messages.file_attachments (0055_session_message_attachments)",
    );
    sqlite.exec(
      "ALTER TABLE session_messages ADD COLUMN file_attachments text",
    );
  }
  if (!columnExists(sqlite, "session_messages", "status")) {
    logger.log(
      "[Schema Fix] Adding session_messages.status (interrupted-turn recovery)",
    );
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
    sqlite.exec(
      "ALTER TABLE apps ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'local'",
    );
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
      .prepare(
        "SELECT id, api_key FROM provider_api_keys WHERE api_key IS NOT NULL",
      )
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
    const update = sqlite.prepare(
      "UPDATE mcp_servers SET api_key = ? WHERE id = ?",
    );
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
 * Bug 5: merge duplicate `apps` rows that share a normalized path into the oldest
 * (canonical) row. Two rows for one folder (path differing by trailing slash,
 * separators, or case) caused permission rules written under the selected row to
 * be enforced under the chat's bound row. Re-points EVERY apps.id FK to the
 * canonical row before deleting the duplicate — required because all those FKs are
 * ON DELETE CASCADE, so an un-re-pointed child would be silently cascade-deleted.
 * Idempotent: a no-op once no path-duplicates remain.
 */
function otherAtlarixIsLive(sqlite: Database.Database): boolean {
  if (!tableExists(sqlite, LIVE_SESSIONS_TABLE)) return false;
  const row = sqlite
    .prepare(`SELECT 1 FROM ${LIVE_SESSIONS_TABLE} WHERE last_seen > ? AND host = ? AND pid != ? LIMIT 1`)
    .get(Date.now() - PEER_STALE_MS, os.hostname(), process.pid);
  return row != null;
}

export function mergeDuplicateAppsByPathIfNeeded(
  sqlite: Database.Database,
): void {
  if (!tableExists(sqlite, "apps")) return;
  const rows = sqlite.prepare("SELECT id, path FROM apps").all() as Array<{
    id: number;
    path: string;
  }>;
  const dupGroups = groupDuplicateAppIds(rows);
  if (dupGroups.length === 0) return;
  // Another Atlarix on this database holds the duplicate's id in memory: deleting
  // the row under it fails its next session insert. The next open merges.
  if (otherAtlarixIsLive(sqlite)) {
    logger.log(`[DB] ${dupGroups.length} duplicate apps group(s) left for the next open: another Atlarix is running`);
    return;
  }

  // Plain re-points. Tables dropped in earlier migrations (pivot_*/blueprint_*)
  // are skipped via tableExists.
  const PLAIN_FKS: Array<[table: string, col: string]> = [
    ["chat_sessions", "workspace_id"],
    ["versions", "app_id"],
    ["mcp_servers", "app_id"],
    ["daily_logs", "workspace_id"],
    ["workspace_snapshots", "app_id"],
    ["pivot_nodes", "workspace_id"],
    ["pivot_edges", "workspace_id"],
    ["pivot_containers", "workspace_id"],
    ["blueprint_snapshots", "workspace_id"],
    ["project_snapshots", "workspace_id"],
    ["review_patterns", "workspace_id"],
    // Missing until E13 (2026-10-20): both CASCADE on the duplicate's delete, so
    // every merge deleted that folder's automations; hooks were left pointing at
    // an id that no longer exists.
    ["automations", "workspace_id"],
    ["atlarix_hooks", "workspace_id"],
  ];
  // Counters unique per (workspace, …keys): a row both have is ADDED into the
  // canonical's, never dropped — these are history, not settings.
  const SUMMED_FKS: Array<[table: string, col: string, keys: string[], sums: string[]]> = [
    ["edit_stats", "workspace_id", ["day", "provider", "model_id"], ["lines_added", "lines_removed", "edits"]],
  ];
  // Collision re-points: a UNIQUE/PK on (fk, …keys) means re-pointing a duplicate
  // could collide with a row the canonical app already has — drop the duplicate's
  // colliding rows first (keep the canonical's), then re-point the remainder.
  const COLLISION_FKS: Array<[table: string, col: string, keys: string[]]> = [
    ["workspace_file_permissions", "app_id", ["scope_type", "scope_value"]],
    ["workspace_command_permissions", "app_id", ["category"]],
    ["project_memory", "workspace_id", ["key"]],
  ];

  let merged = 0;
  const moved: Record<string, number> = {};
  const count = (table: string, n: number) => {
    if (n > 0) moved[table] = (moved[table] ?? 0) + n;
  };
  const run = sqlite.transaction(() => {
    for (const ids of dupGroups) {
      const canonical = ids[0]!;
      for (const dup of ids.slice(1)) {
        for (const [table, col, keys, sums] of SUMMED_FKS) {
          if (!tableExists(sqlite, table)) continue;
          const match = keys.map((k) => `c.${k} = d.${k}`).join(" AND ");
          for (const sum of sums) {
            sqlite
              .prepare(
                `UPDATE ${table} AS c SET ${sum} = c.${sum} + (SELECT d.${sum} FROM ${table} d WHERE d.${col} = ? AND ${match}) WHERE c.${col} = ? AND EXISTS (SELECT 1 FROM ${table} d WHERE d.${col} = ? AND ${match})`,
              )
              .run(dup, canonical, dup);
          }
          const keyCols = keys.join(", ");
          sqlite
            .prepare(`DELETE FROM ${table} WHERE ${col} = ? AND (${keyCols}) IN (SELECT ${keyCols} FROM ${table} WHERE ${col} = ?)`)
            .run(dup, canonical);
          count(table, Number(sqlite.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(canonical, dup).changes));
        }
        for (const [table, col, keys] of COLLISION_FKS) {
          if (!tableExists(sqlite, table)) continue;
          const keyCols = keys.join(", ");
          const lhs = keys.length === 1 ? keys[0] : `(${keyCols})`;
          sqlite
            .prepare(
              `DELETE FROM ${table} WHERE ${col} = ? AND ${lhs} IN (SELECT ${keyCols} FROM ${table} WHERE ${col} = ?)`,
            )
            .run(dup, canonical);
          count(table, Number(sqlite.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(canonical, dup).changes));
        }
        for (const [table, col] of PLAIN_FKS) {
          if (!tableExists(sqlite, table)) continue;
          count(table, Number(sqlite.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(canonical, dup).changes));
        }
        sqlite.prepare("DELETE FROM apps WHERE id = ?").run(dup);
        merged += 1;
      }
    }
  });
  run();
  if (merged > 0) {
    logger.log(
      `[DB] merged ${merged} duplicate apps row(s) into the oldest row for the same folder (symlinks resolved); moved: ${
        Object.entries(moved).map(([t, n]) => `${t}=${n}`).join(" ") || "nothing"
      }`,
    );
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
 * Re-open the database after `reset-all` deleted the file.
 *
 * `reset-all` closes the SQLite handle and unlinks the file, then RETURNS while the
 * app keeps running. Without this, `_db` still pointed at the closed handle and every
 * later query threw better-sqlite3's opaque "The database connection is not open" —
 * the same symptom as the shutdown race, but on a session the user expects to keep
 * using.
 *
 * Deliberately NOT `beginDatabaseClosing()`: that flag is one-way and would brick the
 * session permanently. This is the opposite operation — drop the dead handle and build
 * a fresh one (schema + migrations run again on the new file).
 *
 * Clearing `_db` lives here rather than being an exported setter, so the only way to
 * replace the handle is this one named, documented path.
 */
export function reinitializeDatabaseAfterReset(): void {
  const previous = _db;
  _db = null;
  if (previous) {
    // The caller normally closed it already; closing twice is harmless and closing a
    // still-open handle here prevents leaking it if they didn't.
    closeSqliteSilently(previous.$client as Database.Database);
  }
  initializeDatabase();
  logger.log("[DB] Re-initialized after reset-all");
}

/** Named error thrown when the DB is accessed after shutdown began — lets
 * straggler writes be swallowed quietly instead of surfacing better-sqlite3's
 * opaque "The database connection is not open" as a handled Sentry error. */
export class DatabaseClosingError extends Error {
  constructor() {
    super("Database is closing (shutdown in progress)");
    this.name = "DatabaseClosingError";
  }
}

let _dbClosing = false;

/** Mark the DB as shutting down. After this, `db` access throws
 * DatabaseClosingError so a late async query short-circuits cleanly. */
export function beginDatabaseClosing(): void {
  stopClientHeartbeat?.();
  stopClientHeartbeat = null;
  _dbClosing = true;
}

export function isDatabaseClosing(): boolean {
  return _dbClosing;
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
    // Once shutdown starts, short-circuit with a recognizable error instead of
    // letting a straggler hit a closed handle deep inside a query (opaque throw).
    if (_dbClosing) throw new DatabaseClosingError();
    const database = getDb();
    return database[prop as keyof typeof database];
  },
}) as BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};
