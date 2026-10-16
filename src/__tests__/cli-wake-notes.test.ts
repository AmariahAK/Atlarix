/**
 * "◇ go build … finished · 21s": the line that says background work finished
 * stays where it finished. Anchored to the reply alone, a note from mid-turn
 * sank under every later line of that reply and the notes stacked at the
 * bottom of the transcript (owner, 2026-10-16).
 */
import { describe, expect, it } from "vitest";
import { placeWakeNotes, type WakeNote } from "@/cli/agent/session";
import type { Cell } from "@/cli/agent/transcript";

const md = (id: string): Cell => ({ kind: "markdown", id, text: id });
const note = (id: string, afterCellId: string, afterMessageId = "a1"): WakeNote => ({ id, afterCellId, afterMessageId, text: `◇ ${id} finished · 2s` });
const ids = (cells: Cell[]) => cells.map((c) => c.id);

describe("placeWakeNotes", () => {
  it("keeps a note under the line it finished after while the reply grows", () => {
    const cells = [md("u1:u"), md("a1:p0"), md("a1:t:run1"), md("a1:p1"), md("a1:t:run2")];
    expect(ids(placeWakeNotes(cells, [note("build", "a1:p0"), note("test", "a1:t:run1")]))).toEqual([
      "u1:u",
      "a1:p0",
      "wake:build",
      "a1:t:run1",
      "wake:test",
      "a1:p1",
      "a1:t:run2",
    ]);
  });

  it("orders notes that finished after the same line", () => {
    const cells = [md("a1:p0"), md("a1:p1")];
    expect(ids(placeWakeNotes(cells, [note("one", "a1:p0"), note("two", "a1:p0")]))).toEqual(["a1:p0", "wake:one", "wake:two", "a1:p1"]);
  });

  it("falls back to the end of its message when the line has gone", () => {
    const cells = [md("a1:p0"), md("a1:p1"), md("u2:u")];
    expect(ids(placeWakeNotes(cells, [note("gone", "a1:t:collapsed")]))).toEqual(["a1:p0", "a1:p1", "wake:gone", "u2:u"]);
  });
});
