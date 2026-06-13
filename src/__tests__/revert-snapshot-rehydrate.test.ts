import { describe, expect, it } from "vitest";
import { buildRevertSnapshotMap } from "@/lib/chat/revert-snapshot-rehydrate";

describe("buildRevertSnapshotMap", () => {
  it("maps persisted assistant snapshotTurnId onto the loaded ui message ids", () => {
    const rows = [
      { id: "row-user", role: "user", snapshotTurnId: null },
      { id: "row-a1", role: "assistant", snapshotTurnId: "1001" },
      { id: "row-a2", role: "assistant", snapshotTurnId: "1002" },
      { id: "row-a3", role: "assistant", snapshotTurnId: null }, // no checkpoint
    ];
    const uiMessages = [
      { id: 1, sessionRowId: "row-user" },
      { id: 2, sessionRowId: "row-a1" },
      { id: 3, sessionRowId: "row-a2" },
      { id: 4, sessionRowId: "row-a3" },
      { id: 5 }, // a live message with no persisted row
    ];

    const map = buildRevertSnapshotMap(rows, uiMessages);
    expect(map.get(2)).toBe("1001");
    expect(map.get(3)).toBe("1002");
    expect(map.has(1)).toBe(false); // user message
    expect(map.has(4)).toBe(false); // assistant w/o checkpoint
    expect(map.has(5)).toBe(false); // no sessionRowId
    expect(map.size).toBe(2);
  });

  it("returns an empty map when no rows have a checkpoint", () => {
    const map = buildRevertSnapshotMap(
      [{ id: "r", role: "assistant", snapshotTurnId: null }],
      [{ id: 1, sessionRowId: "r" }],
    );
    expect(map.size).toBe(0);
  });
});
