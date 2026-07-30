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
// Imported statically, NOT with `await import()` inside the test: this module pulls in
// better-sqlite3 (native) plus the 71 bundled migrations, and paying that inside a test
// body counts against the node project's 5s `testTimeout` — which is what made this the
// one job that failed on Windows in v14.23.0 (that runner's collect phase alone took
// 107s). Safe to hoist because `getUserDataPath()` reads ATLARIX_USER_DATA_DIR lazily on
// every call, so `beforeAll` still wins; nothing here opens the db at import time.
import {
  db,
  getDatabasePath,
  initializeDatabase,
  isDbInitialized,
  reinitializeDatabaseAfterReset,
} from "@/db/index";

/** 71 migrations against a cold temp filesystem is slow on CI, not hung. */
const SLOW_DB_TIMEOUT_MS = 60_000;

let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-db-reinit-"));
  process.env.ATLARIX_USER_DATA_DIR = tempDir;
});

afterAll(() => {
  delete process.env.ATLARIX_USER_DATA_DIR;
  // Windows refuses to remove a directory that still has an open handle inside it, and
  // these tests deliberately leave the REINITIALIZED db open. Close it first, then treat
  // cleanup as best-effort: a stray temp dir is harmless, a failed teardown fails the run.
  try {
    db.$client.close();
  } catch {
    // already closed, or never opened because the suite failed earlier
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows can hold the handle briefly after close(); the OS reaps temp dirs anyway
  }
});

describe("reinitializeDatabaseAfterReset", () => {
  it("leaves the db usable after the file is closed and deleted", () => {
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
  }, SLOW_DB_TIMEOUT_MS);

  it("is idempotent — a second call does not close the live handle", () => {
    reinitializeDatabaseAfterReset();
    expect(isDbInitialized()).toBe(true);
    expect(() => db.$client.prepare("SELECT 1").get()).not.toThrow();
  }, SLOW_DB_TIMEOUT_MS);
});
