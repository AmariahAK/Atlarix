import { describe, expect, it } from "vitest";
import { discardedTurnSnapshotIds } from "@/lib/chat/discarded-turn-snapshots";

const msgs = [
  { id: 1, role: "user" },
  { id: 2, role: "assistant" }, // snapshot "2"
  { id: 3, role: "user" },
  { id: 4, role: "assistant" }, // snapshot "4"
  { id: 5, role: "assistant" }, // no snapshot
  { id: 6, role: "assistant" }, // snapshot "6"
];

describe("discardedTurnSnapshotIds", () => {
  const snap = new Map<number, string>([
    [2, "2"],
    [4, "4"],
    [6, "6"],
  ]);

  it("returns assistant turns AFTER the edited message, chronological, snapshots only", () => {
    // Edit message 1 → discards assistants 2,4,5,6; 5 has no snapshot.
    expect(discardedTurnSnapshotIds(msgs, 1, snap)).toEqual(["2", "4", "6"]);
  });

  it("only counts turns after the edited message", () => {
    // Edit message 3 → discards assistants 4,5,6 (not 2).
    expect(discardedTurnSnapshotIds(msgs, 3, snap)).toEqual(["4", "6"]);
  });

  it("returns [] when nothing is discarded (last user message edited)", () => {
    const tail = [
      { id: 1, role: "user" },
      { id: 2, role: "assistant" },
      { id: 3, role: "user" },
    ];
    expect(discardedTurnSnapshotIds(tail, 3, new Map([[2, "2"]]))).toEqual([]);
  });

  it("returns [] when discarded turns have no snapshots", () => {
    expect(discardedTurnSnapshotIds(msgs, 1, new Map())).toEqual([]);
  });

  it("returns [] when the edited id is missing or not a user message", () => {
    expect(discardedTurnSnapshotIds(msgs, 999, snap)).toEqual([]);
    expect(discardedTurnSnapshotIds(msgs, 2, snap)).toEqual([]); // id 2 is assistant
  });
});
