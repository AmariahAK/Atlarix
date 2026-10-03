/**
 * The CLI must not upgrade a database that a 14.x desktop app still uses: that
 * app counts migrations for equality and DELETES a database it finds newer.
 * Measured 2026-10-04: CLI 15.0 applied 0077, desktop 14.52.4 opened the file,
 * and every session was gone.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyEmbeddedSqlMigrations,
  assertNoOlderDesktopForUpgrade,
  markDesktopKeepsNewerDatabase,
  OlderDesktopAppError,
  pendingBundledMigrations,
  runPendingAtlarixMigrations,
} from "@/db/migrate_atlarix";
import { BUNDLED_MIGRATIONS } from "@/db/migrations/bundled.generated";

/** A database a 14.x desktop left behind: every migration but the newest. */
function olderDesktopDb() {
  const db = new Database(":memory:");
  runPendingAtlarixMigrations(db, BUNDLED_MIGRATIONS.slice(0, -1));
  return db;
}

describe("the CLI on a database an older desktop app uses", () => {
  it("refuses to upgrade it, and changes nothing", () => {
    const db = olderDesktopDb();
    const pending = pendingBundledMigrations(db);
    expect(pending.length).toBe(1);
    expect(() => assertNoOlderDesktopForUpgrade(db, pending, {})).toThrow(OlderDesktopAppError);
    expect(pendingBundledMigrations(db)).toEqual(pending);
  });

  it("upgrades it once a 15.0+ desktop has marked it", () => {
    const db = olderDesktopDb();
    markDesktopKeepsNewerDatabase(db);
    const pending = pendingBundledMigrations(db);
    expect(() => assertNoOlderDesktopForUpgrade(db, pending, {})).not.toThrow();
    runPendingAtlarixMigrations(db);
    expect(pendingBundledMigrations(db)).toEqual([]);
  });

  it("a fresh database holds no one's history: it is created as usual", () => {
    const db = new Database(":memory:");
    const pending = pendingBundledMigrations(db);
    expect(pending.length).toBeGreaterThan(0);
    expect(() => assertNoOlderDesktopForUpgrade(db, pending, {})).not.toThrow();
  });

  it("someone who no longer uses the desktop app can say so", () => {
    const db = olderDesktopDb();
    expect(() =>
      assertNoOlderDesktopForUpgrade(db, pendingBundledMigrations(db), { ATLARIX_UPGRADE_SHARED_DB: "1" }),
    ).not.toThrow();
  });

  it("nothing pending: nothing to refuse", () => {
    const db = new Database(":memory:");
    applyEmbeddedSqlMigrations(db);
    expect(() => assertNoOlderDesktopForUpgrade(db, [], {})).not.toThrow();
  });

  it("the mark is idempotent and keeps the meta table readable by older readers", () => {
    const db = new Database(":memory:");
    applyEmbeddedSqlMigrations(db);
    markDesktopKeepsNewerDatabase(db);
    markDesktopKeepsNewerDatabase(db);
    expect(db.prepare("SELECT count(*) AS n FROM __atlarix_schema_meta").get()).toEqual({ n: 1 });
  });
});
