/**
 * One folder reached through a symlink is one workspace (E13). VS Code opened
 * `/tmp/x`, the CLI's `process.cwd()` said `/private/tmp/x`, and the same folder
 * got two apps rows: two session lists, two permission sets, two /undo stores.
 *
 * Merging the two must lose nothing. The old merge did not know `automations`
 * or `edit_stats` (both CASCADE on the duplicate's delete) or `atlarix_hooks`
 * (left pointing at a deleted id).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDb, initializeDatabase, mergeDuplicateAppsByPathIfNeeded } from "@/db/index";
import { normalizeAppPath } from "@/lib/canonical-app-path";
import {
  _setShadowSnapshotsRootForTests,
  captureSnapshot,
  listSnapshotFiles,
} from "@/lib/snapshot/snapshot-manager";
import { LIVE_SESSIONS_TABLE } from "@/lib/peers/peers";

let root: string;
let real: string;
let link: string;
let sqlite: Database.Database;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-e13-"));
  real = path.join(root, "project");
  link = path.join(root, "via-link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  process.env.ATLARIX_USER_DATA_DIR = path.join(root, "ud");
  fs.mkdirSync(process.env.ATLARIX_USER_DATA_DIR);
  initializeDatabase();
  sqlite = getDb().$client as unknown as Database.Database;
});

afterAll(() => {
  _setShadowSnapshotsRootForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a folder reached through a symlink", () => {
  it("is the same workspace path, and so is a file not written yet", () => {
    expect(normalizeAppPath(link)).toBe(normalizeAppPath(real));
    expect(normalizeAppPath(path.join(link, "src", "new.ts"))).toBe(normalizeAppPath(path.join(real, "src", "new.ts")));
  });
});

/** The two rows one folder used to get, each with what that surface recorded. */
function seedDuplicates(): { older: number; newer: number } {
  const ins = sqlite.prepare("INSERT INTO apps (name, path) VALUES (?, ?)");
  const older = Number(ins.run("project", link).lastInsertRowid);
  const newer = Number(ins.run("project-2", real).lastInsertRowid);
  sqlite
    .prepare("INSERT INTO automations (id, workspace_id, name, enabled, trigger, prompt) VALUES (?, ?, 'Nightly', 1, '{}', 'check')")
    .run(crypto.randomUUID(), newer);
  const stat = sqlite.prepare(
    "INSERT INTO edit_stats (workspace_id, day, provider, model_id, lines_added, lines_removed, edits, updated_at) VALUES (?, ?, 'compass', 'm', ?, ?, ?, 0)",
  );
  stat.run(older, "2026-10-19", 10, 2, 3);
  stat.run(newer, "2026-10-19", 5, 1, 2); // the same bucket: added together
  stat.run(newer, "2026-10-20", 7, 0, 1); // only the duplicate has this day
  sqlite.prepare("INSERT INTO atlarix_hooks (name, trigger, command, workspace_id) VALUES ('fmt', 'post_edit', 'prettier', ?)").run(newer);
  return { older, newer };
}

const count = (sql: string, ...args: unknown[]) => (sqlite.prepare(sql).get(...args) as { n: number }).n;

describe("merging its two apps rows", () => {
  it("keeps the oldest row and everything the other one had", () => {
    const { older, newer } = seedDuplicates();
    mergeDuplicateAppsByPathIfNeeded(sqlite);

    expect(count("SELECT COUNT(*) n FROM apps WHERE id IN (?, ?)", older, newer)).toBe(1);
    expect(count("SELECT COUNT(*) n FROM apps WHERE id = ?", older)).toBe(1);
    expect(count("SELECT COUNT(*) n FROM automations WHERE workspace_id = ?", older)).toBe(1);
    expect(count("SELECT COUNT(*) n FROM atlarix_hooks WHERE workspace_id = ?", older)).toBe(1);
    const stats = sqlite
      .prepare("SELECT day, lines_added a, lines_removed r, edits e FROM edit_stats WHERE workspace_id = ? ORDER BY day")
      .all(older);
    expect(stats).toEqual([
      { day: "2026-10-19", a: 15, r: 3, e: 5 },
      { day: "2026-10-20", a: 7, r: 0, e: 1 },
    ]);
    expect(count("SELECT COUNT(*) n FROM edit_stats WHERE workspace_id = ?", newer)).toBe(0);

    // Run again (every open does): nothing changes.
    mergeDuplicateAppsByPathIfNeeded(sqlite);
    expect(sqlite.prepare("SELECT day, lines_added a FROM edit_stats WHERE workspace_id = ? ORDER BY day").all(older)).toEqual([
      { day: "2026-10-19", a: 15 },
      { day: "2026-10-20", a: 7 },
    ]);
    sqlite.prepare("DELETE FROM apps WHERE id = ?").run(older);
  });

  it("waits while another Atlarix is running on this database", () => {
    const { older, newer } = seedDuplicates();
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${LIVE_SESSIONS_TABLE} (
      session_id TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, socket TEXT NOT NULL, token TEXT NOT NULL,
      name TEXT NOT NULL, workspace TEXT NOT NULL, surface TEXT NOT NULL, busy INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      PRIMARY KEY (session_id, pid, host))`);
    const live = sqlite.prepare(
      `INSERT INTO ${LIVE_SESSIONS_TABLE} (session_id, pid, host, socket, token, name, workspace, surface, busy, last_seen) VALUES ('s', ?, ?, '', '', '', '', 'cli', 0, ?)`,
    );
    live.run(process.pid + 1, os.hostname(), Date.now());
    mergeDuplicateAppsByPathIfNeeded(sqlite);
    expect(count("SELECT COUNT(*) n FROM apps WHERE id IN (?, ?)", older, newer)).toBe(2);

    // It quit (its row went stale): the next open merges.
    sqlite.prepare(`UPDATE ${LIVE_SESSIONS_TABLE} SET last_seen = 0`).run();
    mergeDuplicateAppsByPathIfNeeded(sqlite);
    expect(count("SELECT COUNT(*) n FROM apps WHERE id IN (?, ?)", older, newer)).toBe(1);
  });
});

describe("/undo across the two spellings", () => {
  it("a turn recorded through the link is found through the real path", async () => {
    _setShadowSnapshotsRootForTests(path.join(root, "shadow"));
    fs.writeFileSync(path.join(real, "a.ts"), "one");
    await captureSnapshot({ workspacePath: link, turnId: "turn-link", relativePaths: ["a.ts"] });
    fs.writeFileSync(path.join(real, "a.ts"), "two");
    expect((await listSnapshotFiles(real, "turn-link"))?.filesChanged).toEqual(["a.ts"]);
  });

  it("a turn recorded before paths were resolved is still found", async () => {
    const shadow = path.join(root, "shadow-legacy");
    _setShadowSnapshotsRootForTests(shadow);
    fs.writeFileSync(path.join(real, "b.ts"), "one");
    await captureSnapshot({ workspacePath: link, turnId: "turn-old", relativePaths: ["b.ts"] });
    // Where the old key (the path as given) put it.
    const key = (p: string) => crypto.createHash("sha256").update(p).digest("hex").slice(0, 16);
    const [store] = fs.readdirSync(shadow);
    fs.renameSync(path.join(shadow, store!), path.join(shadow, key(path.resolve(link))));
    _setShadowSnapshotsRootForTests(shadow); // forget what this process learned about the store
    expect((await listSnapshotFiles(link, "turn-old"))?.filesChanged).toEqual(["b.ts"]);
  });
});
