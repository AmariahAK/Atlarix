/**
 * Embedded SQL migrations: no runtime filesystem path to drizzle/.
 * Ledger: __atlarix_migrations. Bridge from legacy __drizzle_migrations via DRIZZLE_HASH_TO_NAME.
 */
import type Database from "better-sqlite3";
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

/**
 * Apply any bundled migration not yet in __atlarix_migrations.
 */
export function runPendingAtlarixMigrations(sqlite: Database.Database): void {
  ensureAtlarixMigrationsTable(sqlite);

  const insert = sqlite.prepare(
    `INSERT INTO ${ATLARIX_MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`,
  );

  for (const m of BUNDLED_MIGRATIONS) {
    if (isMigrationApplied(sqlite, m.name)) {
      continue;
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
