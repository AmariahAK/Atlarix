/**
 * `reset-all` closes the SQLite handle and unlinks the file, then RETURNS while the
 * app keeps running. Before v14.23.0 `_db` still pointed at the closed handle, so
 * every query after a reset threw better-sqlite3's opaque "The database connection is
 * not open" — the shutdown-race symptom, on a session the user expects to keep using.
 *
 * This asserts the observable contract: after a reset-and-reinit the db is usable
 * again. Uses a real temp SQLite file via `ATLARIX_USER_DATA_DIR` (the same override
 * the headless CLI uses), so it exercises the actual open → close → unlink → reopen
 * path rather than a mock of it.
 *
 * Lives in its own FILE on purpose: `db-closing-guard.test.ts` sets the one-way
 * `_dbClosing` flag, which would make every `db` access here throw.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-db-reinit-"));
  process.env.ATLARIX_USER_DATA_DIR = tempDir;
});

afterAll(() => {
  delete process.env.ATLARIX_USER_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("reinitializeDatabaseAfterReset", () => {
  it("leaves the db usable after the file is closed and deleted", async () => {
    const {
      db,
      getDatabasePath,
      initializeDatabase,
      isDbInitialized,
      reinitializeDatabaseAfterReset,
    } = await import("@/db/index");

    initializeDatabase();
    expect(isDbInitialized()).toBe(true);

    const dbPath = getDatabasePath();
    expect(fs.existsSync(dbPath)).toBe(true);

    // Exactly what the reset-all handler does.
    db.$client.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    expect(fs.existsSync(dbPath)).toBe(false);

    reinitializeDatabaseAfterReset();

    // A fresh file exists...
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(isDbInitialized()).toBe(true);
    // ...and a real query runs instead of throwing "connection is not open".
    // Reading through the `db` proxy is the point: that is the handle every caller
    // uses, and it is what pointed at the dead connection before.
    expect(() => db.$client.prepare("SELECT 1").get()).not.toThrow();
  });

  it("is idempotent — a second call does not close the live handle", async () => {
    const { db, isDbInitialized, reinitializeDatabaseAfterReset } = await import(
      "@/db/index"
    );
    reinitializeDatabaseAfterReset();
    expect(isDbInitialized()).toBe(true);
    expect(() => db.$client.prepare("SELECT 1").get()).not.toThrow();
  });
});
