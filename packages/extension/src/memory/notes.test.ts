/**
 * The note store, and the migration off the 50 sentences.
 *
 * THE TESTS THAT EARN THEIR PLACE are the ones about what is left on disk:
 * an orphaned note key after an erase, and an index line pointing at a body
 * that is not there. Neither is visible until someone goes looking, and both
 * are the kind of thing `sessions/store.ts` already records having been bitten
 * by once.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildNotesSection, indexLine, parseNoteRef } from "./index-render";
import { MIGRATED_NOTE, migrateLegacyFacts } from "./migrate";
import {
  deleteAllNotes,
  deleteNote,
  listNotes,
  readNote,
  saveNote,
  slugify,
} from "./notes";

let storage: Map<string, unknown>;

beforeEach(() => {
  storage = new Map();
  const area = {
    async get(key?: string | null) {
      return typeof key === "string" && storage.has(key)
        ? { [key]: storage.get(key) }
        : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) storage.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
    },
    async clear() {
      storage.clear();
    },
  };
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: area, sync: area },
  };
});

const input = (name: string, body = "Body text.") => ({
  name,
  title: name,
  description: `about ${name}`,
  type: "user" as const,
  body,
});

describe("writing and reading", () => {
  it("round-trips a note and lists its metadata", async () => {
    await saveNote(input("preferences"));
    const note = await readNote("preferences");
    expect(note?.body).toBe("Body text.");
    const index = await listNotes();
    expect(index).toHaveLength(1);
    expect(index[0].bytes).toBe("Body text.".length);
    // The index carries NO body — that is what makes reading it every turn cheap.
    expect(index[0]).not.toHaveProperty("body");
  });

  it("bumps rev on every write but does not mark it synced", async () => {
    const first = await saveNote(input("a"));
    const second = await saveNote(input("a", "Changed."));
    expect(second.rev).toBe(first.rev + 1);
    // `rev > syncedRev` is the exact "this device has unpushed edits" test.
    expect(second.syncedRev).toBe(0);
    expect(second.rev).toBeGreaterThan(second.syncedRev);
  });

  it("keeps createdAt across a rewrite", async () => {
    const first = await saveNote(input("a"));
    const second = await saveNote(input("a", "Changed."));
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("stores one key per note, not one blob", async () => {
    // `chrome.storage.local` has no partial write, so a single array would mean
    // re-serialising every note to change one description.
    await saveNote(input("a"));
    await saveNote(input("b"));
    expect(storage.has("atlarix.note.a.v1")).toBe(true);
    expect(storage.has("atlarix.note.b.v1")).toBe(true);
    expect(storage.has("atlarix.notes.index.v1")).toBe(true);
  });
});

describe("what is left on disk", () => {
  it("removes the body when a note is deleted", async () => {
    await saveNote(input("a"));
    expect(await deleteNote("a")).toBe(true);
    expect(storage.has("atlarix.note.a.v1")).toBe(false);
    expect(await listNotes()).toEqual([]);
  });

  it("ERASES EVERY per-note key, not just the index", async () => {
    // The trap: the old store was one key, so its `forgetAll` removed one. With
    // a key per note, clearing only the index leaves every body on disk while
    // the UI reports an empty store.
    await saveNote(input("a"));
    await saveNote(input("b"));
    await deleteAllNotes();
    expect([...storage.keys()]).toEqual([]);
  });

  it("reports false rather than throwing when there is nothing to delete", async () => {
    expect(await deleteNote("never-existed")).toBe(false);
  });
});

describe("reading back what a local process may have rewritten", () => {
  it("drops malformed index rows instead of throwing in a prompt builder", async () => {
    // `storage.local` is a LevelDB directory any process running as the user can
    // edit. A bad row must cost one note, not the turn.
    storage.set("atlarix.notes.index.v1", {
      notes: [{ name: "ok", title: "", description: "", type: "user", bytes: 0, updatedAt: 1, rev: 1, syncedRev: 0 }, { nope: true }, null, "x"],
    });
    expect(await listNotes()).toHaveLength(1);
  });

  it("returns null for a note whose stored value is the wrong shape", async () => {
    storage.set("atlarix.note.a.v1", { name: "a" });
    expect(await readNote("a")).toBeNull();
  });

  it("refuses a name that could not be a safe storage key", async () => {
    expect(await readNote("../../etc/passwd")).toBeNull();
    expect(await deleteNote("Has Spaces")).toBe(false);
  });
});

describe("names", () => {
  it("slugifies a title into something usable", () => {
    expect(slugify("Metric Units & 24h Clock")).toBe("metric-units-24h-clock");
    expect(slugify("!!!")).toBe("");
  });

  it("accepts every ref shape a model will send back", () => {
    expect(parseNoteRef("preferences")).toBe("preferences");
    expect(parseNoteRef("preferences.md")).toBe("preferences");
    expect(parseNoteRef("- [Metric units](preferences.md) — hook")).toBe(
      "preferences",
    );
  });
});

describe("the index the model sees", () => {
  it("renders title, file and hook on one line", () => {
    expect(
      indexLine({
        name: "preferences",
        title: "Metric units",
        description: "wants metric in every answer",
        type: "user",
        bytes: 10,
        updatedAt: 1,
        rev: 1,
        syncedRev: 0,
      }),
    ).toBe("- [Metric units](preferences.md) — wants metric in every answer");
  });

  it("is null at zero notes, so the section is omitted entirely", () => {
    // "a 'you have 0 notes' line is pure cost" — paid on every round by every
    // user who has never saved anything, which is most of them.
    expect(buildNotesSection([])).toBeNull();
  });
});

describe("migrating the 50 sentences", () => {
  const legacy = (texts: string[]) => ({
    facts: texts.map((text, i) => ({ id: `f${i}`, text, createdAt: i })),
  });

  it("folds every fact into ONE note, in order", async () => {
    // Fifty notes would be ~1,400 tokens of index every round — worse than the
    // thing being replaced — and fifty auto-generated retrieval keys would all
    // be bad ones.
    storage.set("atlarix.memory.v1", legacy(["Prefers metric.", "Lives in Nairobi."]));
    const note = await migrateLegacyFacts();
    expect(note?.name).toBe(MIGRATED_NOTE);
    expect(note?.body).toBe("- Prefers metric.\n- Lives in Nairobi.");
    expect(await listNotes()).toHaveLength(1);
  });

  it("leaves the legacy key in place — copying is recoverable, deleting is not", async () => {
    storage.set("atlarix.memory.v1", legacy(["Prefers metric."]));
    await migrateLegacyFacts();
    expect(storage.has("atlarix.memory.v1")).toBe(true);
  });

  it("is a no-op the second time", async () => {
    storage.set("atlarix.memory.v1", legacy(["Prefers metric."]));
    expect(await migrateLegacyFacts()).not.toBeNull();
    expect(await migrateLegacyFacts()).toBeNull();
    expect(await listNotes()).toHaveLength(1);
  });

  it("migrates nothing and throws nothing on a corrupt legacy value", async () => {
    // It runs on the path that builds a prompt; a bad value must cost an empty
    // notes section and no more.
    storage.set("atlarix.memory.v1", { facts: "not an array" });
    expect(await migrateLegacyFacts()).toBeNull();
    storage.set("atlarix.memory.v1", "garbage");
    expect(await migrateLegacyFacts()).toBeNull();
  });

  it("does nothing when there was never a legacy store", async () => {
    expect(await migrateLegacyFacts()).toBeNull();
  });
});
