/**
 * Size and fullness.
 *
 * PURE, so the thresholds are reachable directly rather than by driving a fake
 * storage area to 512 KB. The two behaviours worth the file are the ones that
 * decide whether a full store is recoverable: a rewrite that shrinks must
 * succeed at the cap, and a refusal must name the note and the overage.
 */

import { describe, expect, it } from "vitest";
import { checkWrite, planNotesCompaction } from "./compaction";
import {
  MAX_NOTES,
  NOTES_TOTAL_MAX_BYTES,
  NOTE_MAX_BYTES,
} from "./limits";
import type { NoteMeta } from "./notes";

function note(name: string, bytes: number): NoteMeta {
  return {
    name,
    title: name,
    description: "",
    type: "user",
    bytes,
    updatedAt: 1,
    rev: 1,
    syncedRev: 1,
  };
}

const few = [note("a", 1_000), note("b", 2_000)];

describe("the flag", () => {
  it("says nothing at all when there is nothing to say", () => {
    // The common case, and the reason the header costs nothing until it matters.
    expect(planNotesCompaction({ notes: few })).toBeNull();
  });

  it("names the largest notes to merge once the store is full", () => {
    const notes = Array.from({ length: MAX_NOTES + 1 }, (_, i) =>
      note(`n${i}`, (i + 1) * 100),
    );
    const plan = planNotesCompaction({ notes });
    expect(plan?.full).toBe(true);
    expect(plan?.flag).toContain("FULL");
    // Largest first, so the suggestion is worth taking.
    expect(plan?.targets[0].name).toBe(`n${MAX_NOTES}`);
  });

  it("warns before it refuses", () => {
    const notes = Array.from({ length: 25 }, (_, i) => note(`n${i}`, 100));
    const plan = planNotesCompaction({ notes });
    expect(plan?.full).toBe(false);
    expect(plan?.flag).toContain("getting full");
  });
});

describe("whether a write may proceed", () => {
  it("refuses a note over the per-note cap, naming it and the overage", () => {
    // A model told only "too big" retries at the same size or abandons the
    // note; told the number, it cuts.
    const v = checkWrite({ notes: few }, { name: "big", bytes: NOTE_MAX_BYTES + 5_000 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("big.md");
    expect(v.reason).toMatch(/4\.9 KB over/);
  });

  it("refuses a NEW note past the count cap, naming what to merge", () => {
    const notes = Array.from({ length: MAX_NOTES }, (_, i) =>
      note(`n${i}`, (i + 1) * 100),
    );
    const v = checkWrite({ notes }, { name: "fresh", bytes: 100 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("Merge two of these");
    expect(v.reason).toContain("Rewriting a note you already have still works");
  });

  it("ALLOWS a shrinking rewrite at the cap — the escape hatch", () => {
    // THE BEHAVIOUR THAT MAKES FULL RECOVERABLE. At 30 notes, merging two into
    // one is a write that must succeed while full, because it is the thing that
    // fixes being full. Refusing it leaves deletion as the only way out, and
    // the model will delete the wrong thing.
    const notes = Array.from({ length: MAX_NOTES }, (_, i) =>
      note(`n${i}`, 5_000),
    );
    expect(checkWrite({ notes }, { name: "n0", bytes: 1_000 }).ok).toBe(true);
  });

  it("allows a rewrite that does not grow the store even when over total", () => {
    const notes = [note("a", NOTES_TOTAL_MAX_BYTES)];
    expect(checkWrite({ notes }, { name: "a", bytes: 1_000 }).ok).toBe(true);
  });

  it("refuses a write that would push the store over its total", () => {
    const notes = [note("a", NOTES_TOTAL_MAX_BYTES - 1_000)];
    const v = checkWrite({ notes }, { name: "b", bytes: 20_000 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/over the .* total/);
  });

  it("nudges on a successful write that is getting close", () => {
    // Refinement, not failure: the write lands and the model is told to tighten
    // it next time.
    const v = checkWrite({ notes: few }, { name: "a", bytes: NOTE_MAX_BYTES * 0.9 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.nudge).toMatch(/tighten it/);
  });

  it("says nothing on an ordinary small write", () => {
    const v = checkWrite({ notes: few }, { name: "a", bytes: 400 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.nudge).toBeUndefined();
  });
});
