import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyEmbeddedSqlMigrations } from "@/db/migrate_atlarix";

/**
 * `session_search` may only ever reach messages of a LIVE session in the CALLING
 * workspace. Two independent guarantees, tested independently, because either one
 * failing on its own is a data leak:
 *
 *  1. STORAGE — deleting a session cascades its messages away, so there is
 *     nothing left to find. (`session_messages.session_id` → `chat_sessions.id`
 *     ON DELETE CASCADE, and the connection sets `foreign_keys = ON`; SQLite
 *     enforces neither by default, so both halves are asserted here rather than
 *     assumed from the schema declaration.)
 *
 *  2. QUERY SHAPE — even if a row somehow outlived its session, the tool cannot
 *     see it. Every message lookup is keyed by a session id that was itself just
 *     read out of `chat_sessions` filtered by `workspaceId`. There is no code path
 *     that queries `session_messages` by anything else, so an orphan is
 *     unreachable regardless of whether the cascade fired.
 *
 * The second is the one that survives a future migration turning FKs off, which is
 * why it is not enough to test the first.
 *
 * SCOPE OF THIS FILE. The queries below MIRROR the tool's shape rather than being
 * it, so they are only as good as the mirror — worth having for the FK-off case,
 * which needs a database configured wrongly on purpose. The real query (a
 * `ROW_NUMBER() OVER (PARTITION BY session_id)` window over a workspace-filtered
 * JOIN) is driven directly, across two workspaces and through a real deletion, in
 * `tests/agent-evals/session-search.eval.test.ts`. Change one and check the other.
 */

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyEmbeddedSqlMigrations(db);
  return db;
}

function seedWorkspace(db: Database.Database, id: number, name: string) {
  db.prepare(
    "INSERT INTO apps (id, name, path, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())",
  ).run(id, name, `/tmp/${name}`);
}

function seedSession(
  db: Database.Database,
  sessionId: string,
  workspaceId: number,
  title: string,
) {
  db.prepare(
    "INSERT INTO chat_sessions (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())",
  ).run(sessionId, workspaceId, title);
}

function seedMessage(
  db: Database.Database,
  id: string,
  sessionId: string,
  role: string,
  content: string,
) {
  db.prepare(
    "INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, unixepoch())",
  ).run(id, sessionId, role, content);
}

const countMessages = (db: Database.Database, sessionId: string) =>
  (
    db
      .prepare("SELECT count(*) AS n FROM session_messages WHERE session_id = ?")
      .get(sessionId) as { n: number }
  ).n;

describe("1. storage: a deleted session takes its messages with it", () => {
  it("cascades session_messages away when the session is deleted", () => {
    const db = freshDb();
    seedWorkspace(db, 1, "ws-one");
    seedSession(db, "s-live", 1, "Live session");
    seedMessage(db, "m1", "s-live", "user", "the secret is hunter2");
    expect(countMessages(db, "s-live")).toBe(1);

    db.prepare("DELETE FROM chat_sessions WHERE id = ?").run("s-live");

    // If this is ever 1, a deleted conversation is still searchable.
    expect(countMessages(db, "s-live")).toBe(0);
  });

  it("has foreign keys actually ENFORCED, not merely declared", () => {
    const db = freshDb();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    seedWorkspace(db, 1, "ws-one");
    // A message for a session that does not exist must be refused outright.
    expect(() =>
      seedMessage(db, "orphan", "s-does-not-exist", "user", "leaked"),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("2. query shape: the tool's lookups cannot reach an orphan", () => {
  /**
   * Mirrors exactly what `resolveSessions` + the message queries in
   * `lib/tools/sessions.ts` do: resolve the session THROUGH the workspace filter,
   * then read messages only by a resolved id.
   */
  function resolveThenRead(
    db: Database.Database,
    workspaceId: number,
    sessionId: string,
  ): string[] {
    const session = db
      .prepare("SELECT id FROM chat_sessions WHERE id = ? AND workspace_id = ?")
      .get(sessionId, workspaceId) as { id: string } | undefined;
    if (!session) return [];
    return (
      db
        .prepare("SELECT content FROM session_messages WHERE session_id = ?")
        .all(session.id) as Array<{ content: string }>
    ).map((r) => r.content);
  }

  it("returns nothing for a session in ANOTHER workspace", () => {
    const db = freshDb();
    seedWorkspace(db, 1, "ws-one");
    seedWorkspace(db, 2, "ws-two");
    seedSession(db, "s-other", 2, "Someone else's work");
    seedMessage(db, "m1", "s-other", "user", "private to workspace two");

    // The row exists and is readable with a raw query...
    expect(countMessages(db, "s-other")).toBe(1);
    // ...but not through the workspace-filtered resolve the tool uses.
    expect(resolveThenRead(db, 1, "s-other")).toEqual([]);
    // Sanity: its own workspace still sees it, so the filter is doing the work
    // rather than the query being broken.
    expect(resolveThenRead(db, 2, "s-other")).toEqual(["private to workspace two"]);
  });

  it("returns nothing for an ORPHANED row whose session is gone (FKs bypassed)", () => {
    // Deliberately reconstruct the state a future FK regression would produce.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    applyEmbeddedSqlMigrations(db);
    seedWorkspace(db, 1, "ws-one");
    seedSession(db, "s-doomed", 1, "Deleted session");
    seedMessage(db, "m1", "s-doomed", "user", "should be unreachable");
    db.prepare("DELETE FROM chat_sessions WHERE id = ?").run("s-doomed");

    // With FKs off the cascade did NOT fire, so the orphan is still on disk...
    expect(countMessages(db, "s-doomed")).toBe(1);
    // ...and the tool still cannot reach it, because the session resolve comes
    // first and finds nothing. This is the guarantee that does not depend on
    // SQLite being configured correctly.
    expect(resolveThenRead(db, 1, "s-doomed")).toEqual([]);
  });

  it("a title lookup cannot cross workspaces either", () => {
    const db = freshDb();
    seedWorkspace(db, 1, "ws-one");
    seedWorkspace(db, 2, "ws-two");
    seedSession(db, "s-a", 1, "Refactor the parser");
    seedSession(db, "s-b", 2, "Refactor the parser");

    const found = db
      .prepare(
        "SELECT id FROM chat_sessions WHERE workspace_id = ? AND lower(title) LIKE ?",
      )
      .all(1, "%refactor%") as Array<{ id: string }>;
    expect(found.map((r) => r.id)).toEqual(["s-a"]);
  });
});
