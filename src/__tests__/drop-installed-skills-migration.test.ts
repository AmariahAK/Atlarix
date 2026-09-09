/**
 * Migration 0076 on an EXISTING database — the only case that matters here.
 *
 * Dropping `installed_skills` with the skills marketplace is a no-op on a fresh
 * install: the table is created by 0042 and dropped by 0076 in the same run, so every
 * eval in this repo (all of which build from scratch) would pass whether or not the
 * migration shipped at all. The users who HAVE the table are exactly the ones a
 * from-scratch test cannot represent.
 *
 * And it nearly did not ship. The `.sql` file was hand-written without the
 * `drizzle/meta/_journal.json` entry that `drizzle-kit generate` would have produced,
 * and the bundler reads the journal — so `bundled.generated.ts` skipped it silently and
 * the DROP would never have run on any machine. Nothing failed; the table would simply
 * have survived forever. This test is what makes that visible, because it is the only
 * thing here that would go red.
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

const MIGRATION = "0076_drop_installed_skills";

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

/** A database as it stood in the previous release: everything up to, not including, 0076. */
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

/** One row, as `skills:install` used to write it. */
function seedInstalledSkill(db: Database.Database): void {
  db.prepare(
    `INSERT INTO installed_skills
       (id, name, version, author, description, tags, compatible_modes,
        installed_at, scope, workspace_path, cached_files)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "pdf-tools",
    "pdf-tools",
    "1.0.0",
    "someone",
    "Extract PDF form fields.",
    "[]",
    "[]",
    Date.now(),
    "workspace",
    "/tmp/demo",
    "[]",
  );
}

describe("dropping installed_skills on an upgraded database", () => {
  it("is actually bundled — the journal entry is what makes it ship", () => {
    // Guards the specific way this went wrong: the SQL file existed, the
    // seed-verification branch existed, and the migration was absent from the bundle.
    expect(BUNDLED_MIGRATIONS.map((m) => m.name)).toContain(MIGRATION);
  });

  it("removes a table that already exists and holds rows", () => {
    const db = dbAtPreviousRelease();
    expect(tableExists(db, "installed_skills")).toBe(true);
    seedInstalledSkill(db);

    runPendingAtlarixMigrations(db);

    expect(tableExists(db, "installed_skills")).toBe(false);
    expect(countAtlarixMigrations(db)).toBe(expectedBundledMigrationCount());
    db.close();
  });

  it("leaves the tables the marketplace deletion did NOT touch", () => {
    // The blast radius is one table. `apps` and `mcp_servers` in particular are
    // adjacent in the same release's work, and a DROP aimed at the wrong name would
    // otherwise only surface at runtime.
    const db = dbAtPreviousRelease();
    seedInstalledSkill(db);
    db.prepare("INSERT INTO apps (name, path) VALUES (?, ?)").run(
      "demo",
      "/tmp/demo",
    );

    runPendingAtlarixMigrations(db);

    expect(tableExists(db, "apps")).toBe(true);
    expect(tableExists(db, "mcp_servers")).toBe(true);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM apps").get() as { c: number }).c,
    ).toBe(1);
    db.close();
  });

  it("is recognised by the seed verifier — by ABSENCE, which is the inverted case", () => {
    // Every other branch in `isJournalMigrationApplied` asserts a table or column
    // EXISTS. A drop has to assert the opposite, and getting that backwards would mark
    // the migration applied on a database that still has the table — so it would never
    // run, and nothing would say so.
    const db = dbAtPreviousRelease();
    expect(isJournalMigrationApplied(MIGRATION, db)).toBe(false);
    runPendingAtlarixMigrations(db);
    expect(isJournalMigrationApplied(MIGRATION, db)).toBe(true);
    db.close();
  });
});
