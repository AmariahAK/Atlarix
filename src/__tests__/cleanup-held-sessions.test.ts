/**
 * The daily cleanup deletes sessions not updated in 30 days, but never one a
 * running Atlarix holds open (multi-process audit): an idle session can sit open
 * in a window or terminal that long, and deleting it under that process lost
 * whatever it saved next.
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import { db, getDb, initializeDatabase } from "@/db/index";
import { apps, chatSessions, cleanupLog } from "@/db/schema";
import { checkAndRunStartupCleanup, runDailyCleanup } from "@/db/cleanup_jobs";
import { LIVE_SESSIONS_TABLE } from "@/lib/peers/peers";

let sqlite: Database.Database;
let appId: number;

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-cleanup-"));
  initializeDatabase();
  sqlite = getDb().$client as unknown as Database.Database;
  appId = db.insert(apps).values({ name: "ws", path: "/work/ws" }).returning().all()[0]!.id;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${LIVE_SESSIONS_TABLE} (
    session_id TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, socket TEXT NOT NULL, token TEXT NOT NULL,
    name TEXT NOT NULL, workspace TEXT NOT NULL, surface TEXT NOT NULL, busy INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    PRIMARY KEY (session_id, pid, host))`);
});

const exists = (id: string) => db.select().from(chatSessions).where(eq(chatSessions.id, id)).all().length === 1;

describe("the 30-day session cleanup", () => {
  it("keeps an old session a running Atlarix has open, and deletes the rest", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    for (const id of ["held", "gone", "was-held"]) {
      db.insert(chatSessions).values({ id, workspaceId: appId, createdAt: old, updatedAt: old }).run();
    }
    const live = sqlite.prepare(
      `INSERT INTO ${LIVE_SESSIONS_TABLE} (session_id, pid, host, socket, token, name, workspace, surface, busy, last_seen) VALUES (?, ?, ?, '', '', '', '', 'cli', 0, ?)`,
    );
    live.run("held", process.pid + 1, os.hostname(), Date.now());
    // A process that quit long ago: its row is stale, the session is not held.
    live.run("was-held", process.pid + 2, os.hostname(), 0);

    await runDailyCleanup();
    expect(exists("held")).toBe(true);
    expect(exists("gone")).toBe(false);
    expect(exists("was-held")).toBe(false);
  });
});

/**
 * QA (2026-10-21): the startup check read the FIRST cleanup ever (ascending), so
 * from its second day the daily cleanup ran on every app start.
 */
describe("the startup check", () => {
  it("goes by the last cleanup, so one an hour ago means none now", async () => {
    db.delete(cleanupLog).run();
    const day = 24 * 60 * 60 * 1000;
    db.insert(cleanupLog).values({ cleanupDate: new Date(Date.now() - 40 * day) }).run();
    db.insert(cleanupLog).values({ cleanupDate: new Date(Date.now() - 60 * 60 * 1000) }).run();
    await checkAndRunStartupCleanup();
    expect(db.select().from(cleanupLog).all()).toHaveLength(2);
  });

  it("a day and more since the last one runs it", async () => {
    db.delete(cleanupLog).run();
    db.insert(cleanupLog).values({ cleanupDate: new Date(Date.now() - 30 * 60 * 60 * 1000) }).run();
    await checkAndRunStartupCleanup();
    expect(db.select().from(cleanupLog).all()).toHaveLength(2);
  });
});
