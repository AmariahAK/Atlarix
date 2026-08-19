/**
 * Session messages keep their real order when two rows share a second.
 *
 * `session_messages.created_at` defaults to `unixepoch()` — WHOLE SECONDS — so a
 * user message and everything written in the same second carry an IDENTICAL
 * timestamp. Three queries in `workspace_session_handlers.ts` ordered on that
 * column alone (or with `asc(id)`, a random UUID), which leaves ties undefined:
 *
 * 1. `sessions:get` — decides DISPLAY order. A tie could reload a session with the
 *    assistant's reply sitting ABOVE the question it answers. It also feeds a
 *    `.limit()`, so a tie changed WHICH rows survived the newest-N cut.
 * 2. `trimSessionMessagesIfNeeded` — decides which rows are DELETED as excess.
 * 3. `persistEditedSessionMessageById` — decides where the edited row sits, and
 *    everything after it is DELETED. A reply written in the same second as the
 *    message being edited could sort before it and survive the rewind, leaving a
 *    stale answer under an edited question.
 *
 * Found because `stream-transport-contract.eval` flaked under a loaded parallel
 * suite (`expected 'assistant' to be 'user'`) and passed in isolation — the giveaway
 * that the order was never guaranteed, only usually lucky.
 *
 * These tests assert against REAL SQLite rather than the handlers, because that is
 * where the guarantee actually lives: the point is that `rowid` is insertion order
 * and `id` is not, which no amount of mocking would demonstrate.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

/** The shape that matters: text UUID pk, second-granularity default timestamp. */
function seedSameSecondSession() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_messages (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  const insert = db.prepare(
    "INSERT INTO session_messages (id, session_id, role, content) VALUES (?, 's1', ?, ?)",
  );
  // UUIDs chosen so lexical id order is the REVERSE of insertion order — the
  // situation `asc(id)` silently got wrong.
  insert.run("zzzzzzzz-0000-0000-0000-000000000001", "user", "question");
  insert.run("aaaaaaaa-0000-0000-0000-000000000002", "assistant", "answer");
  return db;
}

describe("session message ordering when created_at ties", () => {
  it("writes both rows in the SAME second — the tie is the normal case, not an edge case", () => {
    const db = seedSameSecondSession();
    const stamps = db
      .prepare("SELECT created_at FROM session_messages")
      .all() as { created_at: number }[];
    expect(new Set(stamps.map((s) => s.created_at)).size).toBe(1);
    db.close();
  });

  it("orders by rowid tiebreak: question before answer", () => {
    const db = seedSameSecondSession();
    // `sessions:get` takes newest-first then reverses, so reproduce both steps.
    const rows = db
      .prepare(
        "SELECT role FROM session_messages ORDER BY created_at DESC, rowid DESC",
      )
      .all() as { role: string }[];
    expect([...rows].reverse().map((r) => r.role)).toEqual([
      "user",
      "assistant",
    ]);
    db.close();
  });

  it("the OLD `asc(id)` tiebreak puts the answer first — it is deterministic but WRONG", () => {
    // Pins why the fix is `rowid` and not `id`: a stable order is not the same as
    // the right one, and a UUID has no relationship to when the row was written.
    const db = seedSameSecondSession();
    const rows = db
      .prepare(
        "SELECT role FROM session_messages ORDER BY created_at DESC, id DESC",
      )
      .all() as { role: string }[];
    expect([...rows].reverse().map((r) => r.role)).toEqual([
      "assistant",
      "user",
    ]);
    db.close();
  });

  it("rowid ascending is insertion order, which is what the delete paths slice on", () => {
    const db = seedSameSecondSession();
    const rows = db
      .prepare(
        "SELECT role FROM session_messages ORDER BY created_at ASC, rowid ASC",
      )
      .all() as { role: string }[];
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);

    // The rewind keeps everything up to and including the edited row and deletes
    // the rest; with the wrong order it would delete the question and keep the answer.
    const targetPos = rows.findIndex((r) => r.role === "user");
    expect(rows.slice(targetPos + 1).map((r) => r.role)).toEqual(["assistant"]);
    db.close();
  });
});
