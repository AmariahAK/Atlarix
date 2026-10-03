/**
 * Embedded SQL migrations: no runtime filesystem path to drizzle/.
 * Ledger: __atlarix_migrations. Bridge from legacy __drizzle_migrations via DRIZZLE_HASH_TO_NAME.
 */
import type Database from "better-sqlite3";
import os from "node:os";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import {
  BUNDLED_MIGRATIONS,
  DRIZZLE_HASH_TO_NAME,
} from "./migrations/bundled.generated";
import { isJournalMigrationApplied } from "./migration_seed_verification";

const logger = log.scope("db-migrate");

export const ATLARIX_MIGRATIONS_TABLE = "__atlarix_migrations";

/** Thrown when DB has __drizzle_migrations rows whose hash is not in the current build map. Do not DB-wipe retry. */
export class UnknownDrizzleMigrationHashError extends Error {
  readonly unknownHashes: string[];

  constructor(unknownHashes: string[]) {
    super(
      `Unknown __drizzle_migrations hash(es) not in bundled map (re-applying SQL would corrupt DB): ${unknownHashes.join(", ")}`,
    );
    this.name = "UnknownDrizzleMigrationHashError";
    this.unknownHashes = unknownHashes;
  }
}

function splitMigrationStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ensureAtlarixMigrationsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${ATLARIX_MIGRATIONS_TABLE} (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

/**
 * Copy legacy Drizzle journal rows into __atlarix_migrations by hash → name.
 * Unknown hashes: logger.error + Sentry + throw (never silent).
 */
export function bridgeDrizzleMigrationsIfNeeded(
  sqlite: Database.Database,
): void {
  const drizzleExists = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
    )
    .get();
  if (!drizzleExists) {
    return;
  }

  const rows = sqlite
    .prepare(
      "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC, rowid ASC",
    )
    .all() as Array<{ hash: string; created_at: number | string | null }>;

  if (rows.length === 0) {
    return;
  }

  const unknown: string[] = [];
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO ${ATLARIX_MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`,
  );

  const bridgeTx = sqlite.transaction(() => {
    for (const row of rows) {
      const name = DRIZZLE_HASH_TO_NAME[row.hash];
      if (!name) {
        unknown.push(row.hash);
        continue;
      }
      const appliedAt =
        row.created_at != null && row.created_at !== ""
          ? Number(row.created_at)
          : Date.now();
      insert.run(name, Number.isFinite(appliedAt) ? appliedAt : Date.now());
    }
  });

  bridgeTx();

  if (unknown.length > 0) {
    const err = new UnknownDrizzleMigrationHashError(unknown);
    const msg = `[DB] Unknown __drizzle_migrations hash(es) — not in DRIZZLE_HASH_TO_NAME (${unknown.length}): ${unknown.map((h) => h.slice(0, 12) + "…").join(", ")}`;
    logger.error(msg, { unknownHashes: unknown });
    Sentry.captureException(err, {
      extra: {
        unknownHashCount: unknown.length,
        unknownHashesPreview: unknown.slice(0, 5),
      },
    });
    throw err;
  }
}

/**
 * Legacy: apps exists but __atlarix_migrations empty — seed names for migrations already reflected in schema.
 */
export function seedVerifiedAtlarixMigrationsIfNeeded(
  sqlite: Database.Database,
): void {
  const appsExists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='apps'")
    .get();
  if (!appsExists) {
    return;
  }

  ensureAtlarixMigrationsTable(sqlite);

  const count =
    (
      sqlite
        .prepare(`SELECT COUNT(*) as c FROM ${ATLARIX_MIGRATIONS_TABLE}`)
        .get() as { c: number }
    )?.c ?? 0;
  if (count > 0) {
    return;
  }

  logger.log(
    `[Schema Fix] Verified seed of ${ATLARIX_MIGRATIONS_TABLE} (only migrations already reflected in DB).`,
  );

  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO ${ATLARIX_MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`,
  );

  let seeded = 0;
  const tx = sqlite.transaction(() => {
    for (const m of BUNDLED_MIGRATIONS) {
      if (!isJournalMigrationApplied(m.name, sqlite)) {
        logger.log(
          `[Schema Fix] Verified seed stops before ${m.name}; pending migrations will run next.`,
        );
        break;
      }
      insert.run(m.name, m.when);
      seeded++;
    }
  });
  tx();

  if (seeded > 0) {
    logger.log(
      `[Schema Fix] Recorded ${seeded} migration(s) in ${ATLARIX_MIGRATIONS_TABLE}.`,
    );
  }
}

function isMigrationApplied(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare(`SELECT 1 FROM ${ATLARIX_MIGRATIONS_TABLE} WHERE name = ? LIMIT 1`)
    .get(name);
  return !!row;
}

/** Bundled migrations not yet applied to this database, in order. */
export function pendingBundledMigrations(
  sqlite: Database.Database,
  migrations: ReadonlyArray<{ name: string }> = BUNDLED_MIGRATIONS,
): string[] {
  ensureAtlarixMigrationsTable(sqlite);
  return migrations
    .filter((m) => !isMigrationApplied(sqlite, m.name))
    .map((m) => m.name);
}

/**
 * Apply any bundled migration not yet in __atlarix_migrations.
 *
 * A migration that raises `min_reader` (see the note on READER_VERSION) breaks
 * older readers, so it must not run while another Atlarix — the desktop app or
 * the CLI, which share this file — has the database open: that program would go
 * on reading a schema it no longer understands. It waits for them to close.
 */
export function runPendingAtlarixMigrations(
  sqlite: Database.Database,
  migrations: ReadonlyArray<{ name: string; sql: string }> = BUNDLED_MIGRATIONS,
): void {
  ensureAtlarixMigrationsTable(sqlite);

  const insert = sqlite.prepare(
    `INSERT INTO ${ATLARIX_MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`,
  );

  for (const m of migrations) {
    if (isMigrationApplied(sqlite, m.name)) {
      continue;
    }

    if (/\bmin_reader\b/.test(m.sql)) {
      const others = liveOtherClients(sqlite);
      if (others.length > 0) {
        throw new DatabaseInUseForUpgradeError(m.name, others);
      }
    }

    const chunks = splitMigrationStatements(m.sql);
    if (chunks.length === 0) {
      logger.warn(`[Migrations] Skipping empty SQL for ${m.name}`);
      continue;
    }

    logger.log(`[Migrations] Applying embedded migration: ${m.name}`);

    const run = sqlite.transaction(() => {
      for (const chunk of chunks) {
        sqlite.exec(chunk);
      }
      insert.run(m.name, Date.now());
    });
    run();
  }
}

/**
 * Full pipeline: table → bridge from Drizzle → verified seed → run pending.
 */
export function applyEmbeddedSqlMigrations(sqlite: Database.Database): void {
  ensureAtlarixMigrationsTable(sqlite);
  bridgeDrizzleMigrationsIfNeeded(sqlite);
  seedVerifiedAtlarixMigrationsIfNeeded(sqlite);
  runPendingAtlarixMigrations(sqlite);
}

export function countAtlarixMigrations(sqlite: Database.Database): number {
  const hasTable = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(ATLARIX_MIGRATIONS_TABLE);
  if (!hasTable) {
    return 0;
  }
  const row = sqlite
    .prepare(`SELECT COUNT(*) as c FROM ${ATLARIX_MIGRATIONS_TABLE}`)
    .get() as { c: number };
  return row?.c ?? 0;
}

export function expectedBundledMigrationCount(): number {
  return BUNDLED_MIGRATIONS.length;
}

// ─── Two programs, one database ──────────────────────────────────────────────
//
// The desktop app and the CLI open the SAME sqlite.db, and they are updated
// independently, so either can meet a database that a NEWER build of the other
// has already migrated. That is normal and, for additive migrations, harmless:
// an older build simply never touches the new columns and tables.
//
// A migration that WOULD break an older reader (a rename, a drop, a meaning
// change) must also raise `min_reader`, in the same migration:
//   INSERT OR REPLACE INTO __atlarix_schema_meta (key, value) VALUES ('min_reader', '<n>');
// and bump READER_VERSION here to the same <n>. An older build then refuses to
// open the database and says to update, instead of misreading it.

/** The reader generation this build implements. See the note above. */
export const READER_VERSION = 1;

export const SCHEMA_META_TABLE = "__atlarix_schema_meta";

/** The database was migrated by a newer Atlarix that older builds cannot read. Never wipe-retry. */
export class DatabaseNewerThanClientError extends Error {
  constructor(
    readonly minReader: number,
    readonly unknownMigrations: string[],
  ) {
    super(
      `This Atlarix database was upgraded by a newer version of Atlarix (needs reader ${minReader}, this build is ${READER_VERSION}). ` +
        `Update Atlarix — the desktop app and the CLI share it. Nothing was changed.`,
    );
    this.name = "DatabaseNewerThanClientError";
  }
}

/** Migrations recorded in the database that this build does not ship. */
export function unknownAppliedMigrations(sqlite: Database.Database): string[] {
  const hasTable = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(ATLARIX_MIGRATIONS_TABLE);
  if (!hasTable) return [];
  const known = new Set(BUNDLED_MIGRATIONS.map((m) => m.name));
  const rows = sqlite
    .prepare(`SELECT name FROM ${ATLARIX_MIGRATIONS_TABLE}`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((n) => !known.has(n));
}

export function storedMinReader(sqlite: Database.Database): number {
  const hasTable = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(SCHEMA_META_TABLE);
  if (!hasTable) return 1;
  const row = sqlite
    .prepare(`SELECT value FROM ${SCHEMA_META_TABLE} WHERE key = 'min_reader'`)
    .get() as { value?: string } | undefined;
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Throws DatabaseNewerThanClientError when a newer build has migrated this
 * database past what this build can read. Run BEFORE applying migrations, so
 * an older build never writes into a schema it does not understand.
 */
export function assertReadableByThisBuild(sqlite: Database.Database): void {
  const minReader = storedMinReader(sqlite);
  if (minReader > READER_VERSION) {
    throw new DatabaseNewerThanClientError(
      minReader,
      unknownAppliedMigrations(sqlite),
    );
  }
}


// ─── Who else has the database open ──────────────────────────────────────────

export const CLIENTS_TABLE = "__atlarix_clients";
/** A client that has not refreshed its row for this long is gone (crashed or closed). */
export const CLIENT_STALE_MS = 90_000;
export const CLIENT_HEARTBEAT_MS = 30_000;

export interface LiveClient {
  pid: number;
  program: string;
  last_seen: number;
}

export function ensureClientsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${CLIENTS_TABLE} (
      pid INTEGER NOT NULL,
      host TEXT NOT NULL,
      program TEXT NOT NULL,
      reader INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (pid, host)
    )
  `);
}

export function liveOtherClients(
  sqlite: Database.Database,
  now = Date.now(),
  self = { pid: process.pid, host: os.hostname() },
): LiveClient[] {
  ensureClientsTable(sqlite);
  const rows = sqlite
    .prepare(
      `SELECT pid, host, program, last_seen FROM ${CLIENTS_TABLE}
       WHERE last_seen > ? AND NOT (pid = ? AND host = ?)`,
    )
    .all(now - CLIENT_STALE_MS, self.pid, self.host) as Array<LiveClient & { host: string }>;
  const live: LiveClient[] = [];
  for (const row of rows) {
    // A process on THIS machine can be checked directly: a crashed one would
    // otherwise hold up a reader-breaking migration for the full stale window.
    // Another host (a synced or network folder) only has the heartbeat to go on.
    if (row.host === self.host && !processAlive(row.pid)) {
      sqlite
        .prepare(`DELETE FROM ${CLIENTS_TABLE} WHERE pid = ? AND host = ?`)
        .run(row.pid, row.host);
      continue;
    }
    live.push({ pid: row.pid, program: row.program, last_seen: row.last_seen });
  }
  return live;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it just isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Record this process as open on the database; returns a stop function. */
export function registerDatabaseClient(
  sqlite: Database.Database,
  program: string,
): () => void {
  ensureClientsTable(sqlite);
  const host = os.hostname();
  const beat = () => {
    try {
      sqlite
        .prepare(
          `INSERT INTO ${CLIENTS_TABLE} (pid, host, program, reader, last_seen)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (pid, host) DO UPDATE SET last_seen = excluded.last_seen`,
        )
        .run(process.pid, host, program, READER_VERSION, Date.now());
    } catch {
      /* the database is closing; the row goes stale on its own */
    }
  };
  beat();
  const timer = setInterval(beat, CLIENT_HEARTBEAT_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(timer);
    try {
      sqlite
        .prepare(`DELETE FROM ${CLIENTS_TABLE} WHERE pid = ? AND host = ?`)
        .run(process.pid, host);
    } catch {
      /* already closed */
    }
  };
}

/** A reader-breaking migration is waiting for other Atlarix programs to close. Never wipe-retry. */
export class DatabaseInUseForUpgradeError extends Error {
  constructor(
    readonly migration: string,
    readonly others: LiveClient[],
  ) {
    const names = [...new Set(others.map((o) => o.program))].join(" and ");
    super(
      `Atlarix needs to finish updating its data, and the ${names} still has it open. ` +
        `Close the ${names}, then start this again. Nothing was changed.`,
    );
    this.name = "DatabaseInUseForUpgradeError";
  }
}