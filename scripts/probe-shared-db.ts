#!/usr/bin/env bun
/**
 * PROBE: write to a database another Atlarix process has open, through the
 * CLI's own driver (bun:sqlite via src/db/bun-sqlite-compat.ts), and report
 * any "database is locked". For testing the desktop/CLI sharing rules.
 *
 * Writes only to its own scratch table (`__probe_shared_db`), dropped at the
 * end, plus its heartbeat row in __atlarix_clients.
 *
 * Usage: bun --preload ./tests-bun/preload.ts scripts/probe-shared-db.ts <path/to/sqlite.db> [seconds=30]
 * (the preload gives it the CLI's module resolution: electron stub, bun:sqlite).
 */
import Database from "../src/db/bun-sqlite-compat";
import { liveOtherClients, registerDatabaseClient } from "../src/db/migrate_atlarix";

const file = process.argv[2];
const seconds = Number(process.argv[3] ?? 30);
if (!file) throw new Error("usage: bun scripts/probe-shared-db.ts <sqlite.db> [seconds]");

const db = new Database(file, { timeout: 10_000 });
db.pragma("journal_mode = WAL");
const stop = registerDatabaseClient(db as never, "Atlarix CLI (probe)");
console.log("journal mode:", db.pragma("journal_mode", { simple: true }));
console.log("other live clients:", liveOtherClients(db as never));

db.exec("CREATE TABLE IF NOT EXISTS __probe_shared_db (id INTEGER PRIMARY KEY, at INTEGER)");
let writes = 0;
let locked = 0;
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO __probe_shared_db (at) VALUES (?)").run(Date.now());
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master").get();
    })();
    writes++;
  } catch (e) {
    if (/locked|busy/i.test(String(e))) locked++;
    else throw e;
  }
  await Bun.sleep(5);
}
db.exec("DROP TABLE __probe_shared_db");
stop();
db.close();
console.log(`${writes} write transactions, ${locked} locked/busy errors in ${seconds}s`);
process.exit(locked ? 1 : 0);
