/**
 * One Atlarix opening its database for the first time: init, then a write.
 * Prints `OK` or the error. For first-open-race.test.ts.
 *
 *   bun run --preload ./tests-bun/preload.ts tests-bun/fixtures/open-db.ts <userData>
 */
process.env.ATLARIX_USER_DATA_DIR = process.argv[2]!;
try {
  const { initializeDatabase } = await import("../../src/db");
  const db = initializeDatabase();
  db.$client.prepare("INSERT INTO apps (name, path) VALUES (?, ?)").run(`p${process.pid}`, `/w/p${process.pid}`);
  console.log("OK");
  process.exit(0);
} catch (e) {
  console.log(`FAILED ${(e as Error).message}`);
  process.exit(1);
}
