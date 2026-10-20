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
