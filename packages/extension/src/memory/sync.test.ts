/**
 * Reconciling two copies of a note.
 *
 * THE ONE THAT MATTERS is the conflict case. Everything else here is
 * bookkeeping; that one decides whether a user who edits the same note on their
 * laptop and on the website loses what they wrote. Silent last-write-wins is the
 * failure this store cannot afford, so the resolution keeps both and makes the
 * collision visible in the index.
 */

import { describe, expect, it } from "vitest";
import { noteRowFor, reconcileNote, siblingNameFor, type RemoteNote } from "./sync";
import { NOTE_MAX_BYTES } from "./limits";
import type { Note, NoteMeta } from "./notes";

function local(rev: number, syncedRev: number): NoteMeta {
  return {
    name: "preferences",
    title: "Metric",
    description: "metric units",
    type: "user",
    bytes: 10,
    updatedAt: 1,
    rev,
    syncedRev,
  };
}

function remote(rev: number, deleted = false): RemoteNote {
  return {
    name: "preferences",
    title: "Metric",
    description: "metric units",
    type: "user",
    body: "from the server",
    rev,
    deleted_at: deleted ? "2026-09-14T00:00:00Z" : null,
    updated_at: "2026-09-14T00:00:00Z",
  };
}

describe("reconciling", () => {
  it("does nothing when both sides agree", () => {
    expect(reconcileNote(local(3, 3), remote(3)).action).toBe("none");
  });

  it("fast-forwards when the server is ahead and this device is clean", () => {
    expect(reconcileNote(local(3, 3), remote(5)).action).toBe("take-remote");
  });

  it("pushes when this device has edits the server has not seen", () => {
    // `rev > syncedRev` is exact and needs no body hash, because rev only ever
    // increments on a LOCAL write.
    expect(reconcileNote(local(4, 3), remote(3)).action).toBe("push-local");
  });

  it("pushes a note the server has never heard of", () => {
    expect(reconcileNote(local(1, 0), undefined).action).toBe("push-local");
  });

  it("takes a note this device has never heard of", () => {
    expect(reconcileNote(undefined, remote(2)).action).toBe("take-remote");
  });

  it("KEEPS BOTH when each side moved — never silently discards one", () => {
    // Device edited to rev 5 having last synced at 3; the server moved to 4.
    // Both wrote after the last agreed point.
    const plan = reconcileNote(local(5, 3), remote(4));
    expect(plan.action).toBe("conflict");
    if (plan.action !== "conflict") return;
    // The remote copy lands as a SIBLING, which costs an index slot on purpose:
    // a collision the user can see is one they can resolve.
    expect(plan.siblingName).toBe("preferences-from-web");
    expect(plan.name).toBe("preferences");
  });

  it("applies a remote delete only when this device has no unpushed edits", () => {
    expect(reconcileNote(local(3, 3), remote(4, true)).action).toBe(
      "delete-local",
    );
  });

  it("lets a local edit BEAT a remote tombstone", () => {
    // The user wrote here after the delete; honouring the tombstone would throw
    // that away. Pushing resurrects the note, which the RPC allows deliberately.
    expect(reconcileNote(local(5, 3), remote(4, true)).action).toBe(
      "push-local",
    );
  });

  it("ignores a tombstone for a note this device never had", () => {
    expect(reconcileNote(undefined, remote(2, true)).action).toBe("none");
  });
});

describe("sibling names", () => {
  it("stays inside the name length the column will accept", () => {
    const long = "a".repeat(31);
    expect(siblingNameFor(long).length).toBeLessThanOrEqual(32);
    expect(siblingNameFor(long)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe("the projection", () => {
  const note = (body: string): Note => ({
    name: "preferences",
    title: "T".repeat(80),
    description: "D".repeat(200),
    type: "user",
    body,
    bytes: body.length,
    createdAt: 1,
    updatedAt: 2,
    rev: 3,
    syncedRev: 2,
  });

  it("clips every field to the DB's own limit, so a write cannot be rejected", () => {
    const row = noteRowFor(note("x")) as Record<string, string>;
    expect(row.title.length).toBeLessThanOrEqual(48);
    expect(row.description.length).toBeLessThanOrEqual(96);
  });

  it("clips a body by BYTES, not characters", () => {
    // A multi-byte body that fits by `length` and not by `octet_length` would be
    // refused by the column — which is the one rejection the clipping exists to
    // make impossible.
    const row = noteRowFor(note("é".repeat(NOTE_MAX_BYTES))) as Record<
      string,
      string
    >;
    expect(new TextEncoder().encode(row.body).length).toBeLessThanOrEqual(
      NOTE_MAX_BYTES,
    );
  });

  it("sends the rev, which is the whole compare-and-swap", () => {
    const row = noteRowFor(note("x")) as Record<string, number>;
    expect(row.rev).toBe(3);
  });
});
