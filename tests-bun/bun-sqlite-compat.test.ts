/**
 * The CLI's database driver (src/db/bun-sqlite-compat.ts) under the real
 * runtime it ships in. Runs with `bun test tests-bun`, never vitest.
 *
 * The contract is "behaves like better-sqlite3 for everything this codebase and
 * drizzle's better-sqlite3 driver do", so the checks go through the same paths:
 * the embedded migrations, drizzle queries, and the raw-handle calls.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import Database from "../src/db/bun-sqlite-compat";
import { applyEmbeddedSqlMigrations, countAtlarixMigrations, expectedBundledMigrationCount } from "../src/db/migrate_atlarix";
import * as schema from "../src/db/schema";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bun-sqlite-")), "t.db");

describe("bun-sqlite-compat", () => {
  it("applies every embedded migration", () => {
    const db = new Database(tmp(), { timeout: 5000 });
    applyEmbeddedSqlMigrations(db as never);
    expect(countAtlarixMigrations(db as never)).toBe(expectedBundledMigrationCount());
    db.close();
  });

  it("drizzle inserts, selects and updates through it", () => {
    const raw = new Database(tmp());
    applyEmbeddedSqlMigrations(raw as never);
    const db = drizzle(raw as never, { schema });
    const [row] = db.insert(schema.apps).values({ name: "a", path: "/tmp/a" }).returning().all();
    expect(row!.name).toBe("a");
    db.update(schema.apps).set({ name: "b" }).where(eq(schema.apps.id, row!.id)).run();
    const got = db.select().from(schema.apps).where(eq(schema.apps.id, row!.id)).get();
    expect(got?.name).toBe("b");
    // drizzle's relational query builder uses raw() array rows.
    const found = db.query.apps.findFirst({ where: eq(schema.apps.id, row!.id) }).sync();
    expect(found?.path).toBe("/tmp/a");
  });

  it("pragma sets and reads like better-sqlite3", () => {
    const db = new Database(tmp());
    db.pragma("journal_mode = WAL");
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(Array.isArray(db.pragma("table_info(sqlite_master)"))).toBe(true);
  });

  it("transaction commits, and rolls back on throw", () => {
    const db = new Database(tmp());
    db.exec("CREATE TABLE t (x INTEGER)");
    db.transaction(() => db.prepare("INSERT INTO t VALUES (1)").run())();
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (2)").run();
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    expect(db.prepare("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 1 });
  });

  it("get returns undefined for no row, raw() returns arrays", () => {
    const db = new Database(tmp());
    db.exec("CREATE TABLE t (x INTEGER, y TEXT)");
    expect(db.prepare("SELECT * FROM t").get()).toBeUndefined();
    db.prepare("INSERT INTO t VALUES (?, ?)").run(7, "q");
    expect(db.prepare("SELECT x, y FROM t").raw().all()).toEqual([[7, "q"]]);
    expect(db.prepare("SELECT x, y FROM t").raw().get()).toEqual([7, "q"]);
  });

  it("backup writes a complete copy", async () => {
    const file = tmp();
    const db = new Database(file);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42);");
    const dest = file + ".bak";
    await db.backup(dest);
    const copy = new Database(dest, { readonly: true });
    expect(copy.prepare("SELECT x FROM t").get()).toEqual({ x: 42 });
  });
});
