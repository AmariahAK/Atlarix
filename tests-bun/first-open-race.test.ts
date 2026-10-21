/**
 * A8 (QA, 2 of 3): two Atlarix processes opening a brand-new profile at the same
 * moment (the app and the CLI on first run): one failed with "database is
 * locked", then deleted the database the other was still migrating and both
 * hit "disk I/O error".
 */
import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const open = (userData: string) =>
  new Promise<string>((resolve) => {
    const p = spawn(process.execPath, ["run", "--preload", "./tests-bun/preload.ts", "tests-bun/fixtures/open-db.ts", userData], {
      cwd: path.join(import.meta.dir, ".."),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("exit", () => resolve(out.trim().split("\n").at(-1) ?? ""));
  });

it("several first opens at once all come up, on one database", async () => {
  for (let round = 0; round < 4; round++) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "first-open-"));
    try {
      const results = await Promise.all([1, 2, 3, 4].map(() => open(userData)));
      expect(results).toEqual(["OK", "OK", "OK", "OK"]);
      const { Database } = await import("bun:sqlite");
      const db = new Database(path.join(userData, "sqlite.db"), { readonly: true });
      expect((db.query("SELECT COUNT(*) AS n FROM apps").get() as { n: number }).n).toBe(4);
      db.close();
      // And the lock is gone with them.
      expect(fs.existsSync(path.join(userData, "sqlite.db.init-lock"))).toBe(false);
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  }
}, 180_000);

/**
 * A9 (QA): a lock left by a process that ended mid-open, whose pid now belongs
 * to another live process, cost the full 30 s wait on EVERY start, and stayed.
 */
it("an old lock naming someone else's live pid is taken at once", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "first-open-"));
  try {
    const lock = path.join(userData, "sqlite.db.init-lock");
    fs.writeFileSync(lock, String(process.ppid)); // alive, and not an Atlarix opening this database
    const old = new Date(Date.now() - 31_000); // taken longer ago than any open lasts
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    expect(await open(userData)).toBe("OK");
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(fs.existsSync(lock)).toBe(false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}, 60_000);

it("a fresh lock naming a live pid is waited out once, then gone", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "first-open-"));
  try {
    const lock = path.join(userData, "sqlite.db.init-lock");
    fs.writeFileSync(lock, String(process.ppid));
    expect(await open(userData)).toBe("OK");
    expect(fs.existsSync(lock)).toBe(false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}, 90_000);
