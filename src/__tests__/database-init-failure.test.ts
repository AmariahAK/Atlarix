/**
 * Classifying a database-open failure.
 *
 * The point of the classifier is that the right ADVICE differs sharply between
 * causes, so these assert `kind` (the branch) rather than the prose, which will be
 * reworded. The one exception is the downgrade case, where a specific piece of
 * wording is load-bearing: it must not tell someone to reinstall over their data.
 */
import { describe, expect, it } from "vitest";
import { describeDatabaseInitFailure } from "@/main/database-init-failure";
import { UnknownDrizzleMigrationHashError } from "@/db/migrate_atlarix";

describe("native module failures", () => {
  // The message we actually saw on 2026-08-21, kept verbatim as the fixture: this
  // is the case in hand, and a reworded regex that stops matching it would put a
  // real user back at "please restart the app".
  const OBSERVED =
    "The module '/Users/x/Atlarix/node_modules/better-sqlite3/build/Release/better_sqlite3.node' " +
    "was compiled against a different Node.js version using NODE_MODULE_VERSION 141. " +
    "This version of Node.js requires NODE_MODULE_VERSION 148. " +
    "Please try re-compiling or re-installing the module (for instance, using `npm rebuild` or `npm install`).";

  it("classifies the observed ABI mismatch", () => {
    expect(describeDatabaseInitFailure(new Error(OBSERVED)).kind).toBe(
      "native-module",
    );
  });

  it("classifies the other ways a binding fails to load", () => {
    for (const msg of [
      "dlopen(/Applications/Atlarix.app/…/better_sqlite3.node, 0x0001): tried: … (no such file)",
      "Error: Cannot find module 'better-sqlite3'",
      "Symbol not found: _napi_get_last_error_info",
      "%1 is not a valid Win32 application.",
      "invalid ELF header",
    ]) {
      expect(describeDatabaseInitFailure(new Error(msg)).kind, msg).toBe(
        "native-module",
      );
    }
  });

  it("tells the user reinstalling helps and restarting does not", () => {
    const advice = describeDatabaseInitFailure(new Error(OBSERVED));
    // The whole reason this work happened: the old dialog said "please restart",
    // which cannot help, because the retry-and-delete already ran automatically.
    expect(advice.headline).toMatch(/restarting will not/i);
    expect(advice.headline).toMatch(/reinstall/i);
  });
});

describe("a downgrade — the case whose advice is the opposite", () => {
  const err = new UnknownDrizzleMigrationHashError(["abc123", "def456"]);

  it("is recognized by CLASS, not by its message", () => {
    expect(describeDatabaseInitFailure(err).kind).toBe("downgrade");
  });

  /**
   * This is why the class check runs first. The error's own message contains
   * "would corrupt DB" — a message-first classifier reads that as corruption and
   * sends the user to reinstall or reset, over a database that is perfectly
   * healthy and merely newer than the app.
   */
  it("is not mistaken for damage by the word 'corrupt' in its own message", () => {
    expect(err.message).toMatch(/corrupt/i);
    const advice = describeDatabaseInitFailure(err);
    expect(advice.kind).toBe("downgrade");
    expect(advice.headline).toMatch(/nothing is damaged/i);
    expect(advice.headline).toMatch(/nothing needs deleting/i);
  });

  // Load-bearing wording: "latest" would send someone who rolled back to install
  // the same old build again, or worse, over the data this branch protects.
  it("points at the NEWER version, never the latest", () => {
    expect(describeDatabaseInitFailure(err).primaryActionLabel).toMatch(/newer/i);
    expect(describeDatabaseInitFailure(err).primaryActionLabel).not.toMatch(
      /latest/i,
    );
  });
});

describe("storage failures", () => {
  it("classifies a full disk, a permissions problem, or an unopenable path", () => {
    for (const msg of [
      "SQLITE_CANTOPEN: unable to open database file",
      "ENOSPC: no space left on device, write",
      "EACCES: permission denied, mkdir '/Users/x/Library/Application Support/Atlarix'",
      "EROFS: read-only file system",
      "attempt to write a readonly database",
    ]) {
      expect(describeDatabaseInitFailure(new Error(msg)).kind, msg).toBe("storage");
    }
  });
});

describe("anything else", () => {
  it("falls back to unknown without pretending to know", () => {
    expect(describeDatabaseInitFailure(new Error("something odd")).kind).toBe(
      "unknown",
    );
  });

  // A classifier in a failure handler must not itself throw on a strange input.
  it("survives a non-Error being thrown", () => {
    for (const thrown of [undefined, null, "a string", 42, {}]) {
      expect(() => describeDatabaseInitFailure(thrown)).not.toThrow();
      expect(describeDatabaseInitFailure(thrown).kind).toBe("unknown");
    }
  });

  it("still says restarting will not help", () => {
    // True for every branch, because the automatic retry already happened.
    expect(describeDatabaseInitFailure(new Error("???")).headline).toMatch(
      /retried automatically|restarting won't|restarting will not/i,
    );
  });
});

describe("every branch is renderable", () => {
  it("supplies a title, headline, cause and button label", () => {
    const cases: unknown[] = [
      new Error("NODE_MODULE_VERSION 141"),
      new UnknownDrizzleMigrationHashError(["x"]),
      new Error("ENOSPC"),
      new Error("mystery"),
    ];
    for (const c of cases) {
      const a = describeDatabaseInitFailure(c);
      expect(a.title, a.kind).toBeTruthy();
      expect(a.headline, a.kind).toBeTruthy();
      expect(a.likelyCause, a.kind).toBeTruthy();
      expect(a.primaryActionLabel, a.kind).toBeTruthy();
      // The title describes the user's situation, not our internals — the old one
      // said "Database Error", which tells them nothing they can act on.
      expect(a.title, a.kind).not.toMatch(/database error/i);
    }
  });
});
