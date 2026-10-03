/**
 * The desktop app and the CLI open the SAME sqlite.db and are updated
 * separately, so each must cope with a database a newer build has migrated.
 *
 * Before this, an older build counted migrations for EQUALITY, called a newer
 * database inconsistent, and the init failure path then DELETED it and started
 * over: every chat gone, for a version skew.
 */
import Database from "better-sqlite3";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  applyEmbeddedSqlMigrations,
  assertReadableByThisBuild,
  CLIENT_STALE_MS,
  CLIENTS_TABLE,
  DatabaseInUseForUpgradeError,
  DatabaseNewerThanClientError,
  ensureClientsTable,
  liveOtherClients,
  READER_VERSION,
  registerDatabaseClient,
  runPendingAtlarixMigrations,
  SCHEMA_META_TABLE,
  storedMinReader,
  unknownAppliedMigrations,
} from "@/db/migrate_atlarix";
import { describeDatabaseInitFailure } from "@/main/database-init-failure";

function migratedDb() {
  const db = new Database(":memory:");
  applyEmbeddedSqlMigrations(db);
  return db;
}

describe("a database migrated by a newer build", () => {
  it("an additive newer migration is readable by this build", () => {
    const db = migratedDb();
    db.prepare(
      "INSERT INTO __atlarix_migrations (name, applied_at) VALUES ('9999_future_additive', 0)",
    ).run();
    expect(unknownAppliedMigrations(db)).toEqual(["9999_future_additive"]);
    expect(() => assertReadableByThisBuild(db)).not.toThrow();
  });

  it("a newer min_reader is refused, and classified as 'install the newer version'", () => {
    const db = migratedDb();
    db.exec(
      `CREATE TABLE ${SCHEMA_META_TABLE} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
    );
    db.prepare(
      `INSERT INTO ${SCHEMA_META_TABLE} (key, value) VALUES ('min_reader', ?)`,
    ).run(String(READER_VERSION + 1));

    let caught: unknown;
    try {
      assertReadableByThisBuild(db);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatabaseNewerThanClientError);
    // The dialog branch that says nothing is damaged and nothing needs deleting.
    expect(describeDatabaseInitFailure(caught).kind).toBe("downgrade");
  });

  it("a database with no meta table is reader 1", () => {
    expect(() => assertReadableByThisBuild(migratedDb())).not.toThrow();
  });
});

describe("a migration that breaks older readers", () => {
  const breaking = [
    {
      name: "9998_breaking",
      sql: "INSERT OR REPLACE INTO __atlarix_schema_meta (key, value) VALUES ('min_reader', '2')",
    },
  ];

  it("waits while another Atlarix program has the database open", () => {
    const db = migratedDb();
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA_META_TABLE} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
    );
    ensureClientsTable(db);
    db.prepare(
      `INSERT INTO ${CLIENTS_TABLE} (pid, host, program, reader, last_seen) VALUES (?, ?, ?, ?, ?)`,
    ).run(process.pid + 1, "other-host", "Atlarix app", 1, Date.now());

    let caught: unknown;
    try {
      runPendingAtlarixMigrations(db, breaking);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatabaseInUseForUpgradeError);
    expect(describeDatabaseInitFailure(caught).kind).toBe("in-use");
    // Not applied, and the reader bar not raised.
    expect(storedMinReader(db)).toBe(1);
  });

  it("runs once the other program's row has gone stale", () => {
    const db = migratedDb();
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA_META_TABLE} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
    );
    ensureClientsTable(db);
    db.prepare(
      `INSERT INTO ${CLIENTS_TABLE} (pid, host, program, reader, last_seen) VALUES (?, ?, ?, ?, ?)`,
    ).run(process.pid + 1, "other-host", "Atlarix app", 1, Date.now() - CLIENT_STALE_MS - 1);

    runPendingAtlarixMigrations(db, breaking);
    expect(storedMinReader(db)).toBe(2);
  });

  it("an additive migration is not held up by other programs", () => {
    const db = migratedDb();
    ensureClientsTable(db);
    db.prepare(
      `INSERT INTO ${CLIENTS_TABLE} (pid, host, program, reader, last_seen) VALUES (?, ?, ?, ?, ?)`,
    ).run(process.pid + 1, "other-host", "Atlarix CLI", 1, Date.now());
    runPendingAtlarixMigrations(db, [
      { name: "9997_additive", sql: "CREATE TABLE future_thing (id INTEGER)" },
    ]);
    expect(unknownAppliedMigrations(db)).toContain("9997_additive");
  });

  it("this process's own row never blocks it", () => {
    const db = migratedDb();
    const stop = registerDatabaseClient(db, "Atlarix CLI");
    expect(liveOtherClients(db)).toEqual([]);
    stop();
  });

  it("a crashed program on this machine stops counting at once, and its row is removed", () => {
    const db = migratedDb();
    ensureClientsTable(db);
    // A pid that cannot be running: far above any real pid range.
    db.prepare(
      `INSERT INTO ${CLIENTS_TABLE} (pid, host, program, reader, last_seen) VALUES (?, ?, ?, ?, ?)`,
    ).run(2_000_000_000, os.hostname(), "Atlarix CLI", 1, Date.now());
    expect(liveOtherClients(db)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM ${CLIENTS_TABLE}`).get()).toEqual({ c: 0 });
  });
});
