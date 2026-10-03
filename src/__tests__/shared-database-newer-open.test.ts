/**
 * End to end: an OLDER build opening a database a NEWER build has migrated
 * (the desktop app and the CLI share one file and update separately) opens it,
 * and keeps its data.
 *
 * The failure this guards: the old consistency check counted migrations for
 * equality, so the extra row made the database "inconsistent", and the init
 * retry path deleted sqlite.db and started over. Own file: it drives the real
 * `initializeDatabase` against a temp ATLARIX_USER_DATA_DIR.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, getDatabasePath, initializeDatabase, reinitializeDatabaseAfterReset } from "@/db/index";

let tempDir: string;
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-db-newer-"));
  process.env.ATLARIX_USER_DATA_DIR = tempDir;
});
afterAll(() => {
  delete process.env.ATLARIX_USER_DATA_DIR;
  try {
    db.$client.close();
  } catch {}
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

describe("opening a database migrated by a newer build", () => {
  it("keeps the data instead of deleting the file", { timeout: 60_000 }, () => {
    initializeDatabase();
    const file = getDatabasePath();
    db.$client.close();

    // What the newer build left behind: one more migration, and a real row.
    const raw = new Database(file);
    raw.prepare(
      "INSERT INTO __atlarix_migrations (name, applied_at) VALUES ('9999_future_additive', 0)",
    ).run();
    raw.prepare(
      "INSERT INTO apps (name, path, created_at, updated_at) VALUES ('keep-me', '/tmp/keep-me', 0, 0)",
    ).run();
    raw.close();

    reinitializeDatabaseAfterReset();
    const row = db.$client
      .prepare("SELECT name FROM apps WHERE name = 'keep-me'")
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe("keep-me");
  });

  it("copies the database before running a pending migration", { timeout: 60_000 }, () => {
    const file = getDatabasePath();
    db.$client.close();
    // Pretend the newest migration has not run yet on this data.
    const raw = new Database(file);
    const last = raw
      .prepare("SELECT name FROM __atlarix_migrations ORDER BY applied_at DESC, rowid DESC LIMIT 1")
      .get() as { name: string };
    raw.prepare("DELETE FROM __atlarix_migrations WHERE name = ?").run(last.name);
    raw.close();

    reinitializeDatabaseAfterReset();
    const dir = path.join(tempDir, "backups", "before-update");
    const copies = fs.readdirSync(dir).filter((f) => f.endsWith(".db"));
    expect(copies.length).toBe(1);
    // The copy is the data from before the update: it still has the row the first test kept.
    const copy = new Database(path.join(dir, copies[0]!), { readonly: true });
    expect(copy.prepare("SELECT name FROM apps WHERE name = 'keep-me'").get()).toBeTruthy();
    copy.close();
  });
});
