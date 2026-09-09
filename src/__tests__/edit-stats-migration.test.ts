/**
 * Migration 0075 on an EXISTING database.
 *
 * Every eval in this repo builds its database from scratch, so a new migration is
 * always exercised as part of a fresh install — the one case no user is in. This
 * test stands the database up at the previous release's migration level, with rows
 * in the parent table, and then runs the pending-migration path the way a real
 * upgrade does.
 *
 * It also covers the seed-verification branch, which is the piece that has no other
 * caller in tests: `isJournalMigrationApplied` is how a database with legacy tables
 * but an empty ledger decides which migrations to mark as already applied, and a
 * missing branch there silently re-runs DDL against a live database.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BUNDLED_MIGRATIONS } from "@/db/migrations/bundled.generated";
import {
  runPendingAtlarixMigrations,
  countAtlarixMigrations,
  expectedBundledMigrationCount,
  ATLARIX_MIGRATIONS_TABLE,
} from "@/db/migrate_atlarix";
import { isJournalMigrationApplied } from "@/db/migration_seed_verification";

const MIGRATION = "0075_edit_stats";

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

/** A database as it stood in the previous release: everything up to, not including, 0075. */
function dbAtPreviousRelease(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS ${ATLARIX_MIGRATIONS_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  for (const m of BUNDLED_MIGRATIONS) {
    if (m.name === MIGRATION) break;
    for (const stmt of m.sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      db.exec(stmt);
    }
    db.prepare(`INSERT INTO ${ATLARIX_MIGRATIONS_TABLE} (name) VALUES (?)`).run(
      m.name,
    );
  }
  return db;
}

describe("edit_stats migration on an upgraded database", () => {
  it("applies on top of an existing database that already has data", () => {
    const db = dbAtPreviousRelease();
    expect(tableExists(db, "edit_stats")).toBe(false);
    // A populated parent table, so the foreign key is created against real rows
    // rather than an empty schema.
    db.prepare("INSERT INTO apps (name, path) VALUES (?, ?)").run(
      "demo",
      "/tmp/demo",
    );

    runPendingAtlarixMigrations(db);

    expect(tableExists(db, "edit_stats")).toBe(true);
    expect(countAtlarixMigrations(db)).toBe(expectedBundledMigrationCount());
    db.close();
  });

  it("accumulates in one bucket and disappears with its workspace", () => {
    const db = dbAtPreviousRelease();
    db.prepare("INSERT INTO apps (name, path) VALUES (?, ?)").run(
      "demo",
      "/tmp/demo",
    );
    runPendingAtlarixMigrations(db);
    db.exec("PRAGMA foreign_keys = ON");

    const appId = (
      db.prepare("SELECT id FROM apps LIMIT 1").get() as {
        id: number;
      }
    ).id;
    const upsert = db.prepare(`
      INSERT INTO edit_stats
        (workspace_id, day, provider, model_id, lines_added, lines_removed, edits)
      VALUES (?,?,?,?,?,?,1)
      ON CONFLICT (workspace_id, day, provider, model_id) DO UPDATE SET
        lines_added = lines_added + excluded.lines_added,
        lines_removed = lines_removed + excluded.lines_removed,
        edits = edits + 1`);
    upsert.run(
      appId,
      "2026-08-24",
      "compass",
      "deepseek/deepseek-v4-pro",
      10,
      2,
    );
    upsert.run(
      appId,
      "2026-08-24",
      "compass",
      "deepseek/deepseek-v4-pro",
      5,
      1,
    );
    // Same model, same day, but the user's OWN key — a separate row, because that
    // difference is the whole point of keeping `provider`.
    upsert.run(appId, "2026-08-24", "deepseek", "deepseek-v4-pro", 7, 0);

    const rows = db
      .prepare(
        "SELECT provider, lines_added, lines_removed, edits FROM edit_stats ORDER BY provider",
      )
      .all() as Array<{
      provider: string;
      lines_added: number;
      lines_removed: number;
      edits: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider: "compass",
      lines_added: 15,
      lines_removed: 3,
      edits: 2,
    });
    expect(rows[1]).toMatchObject({ provider: "deepseek", lines_added: 7 });

    // Removing a project takes its counts with it rather than leaving orphans
    // that the totals would keep including.
    db.prepare("DELETE FROM apps WHERE id = ?").run(appId);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM edit_stats").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    db.close();
  });

  it("is recognised by the seed verifier once applied", () => {
    const db = dbAtPreviousRelease();
    // The branch must answer FALSE before and TRUE after — a missing branch
    // always answers false, which re-runs the DDL against a live database.
    expect(isJournalMigrationApplied(MIGRATION, db)).toBe(false);
    runPendingAtlarixMigrations(db);
    expect(isJournalMigrationApplied(MIGRATION, db)).toBe(true);
    db.close();
  });
});
