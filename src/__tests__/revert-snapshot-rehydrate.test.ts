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

  // Bug 6: the `sessions:snapshot-turn-ids` IPC returns {rowId, snapshotTurnId};
  // SimpleInlineChat maps it to the {id, role, snapshotTurnId} row shape this
  // helper consumes. Lock that contract so the relaunch rehydrate keeps working.
  it("rehydrates from the IPC {rowId, snapshotTurnId} shape", () => {
    const ipcRows = [
      { rowId: "row-a1", snapshotTurnId: "2001" },
      { rowId: "row-a2", snapshotTurnId: "2002" },
    ];
    const uiMessages = [
      { id: 10, sessionRowId: "row-a1" },
      { id: 11, sessionRowId: "row-a2" },
      { id: 12, sessionRowId: "row-unmatched" },
    ];
    const map = buildRevertSnapshotMap(
      ipcRows.map((r) => ({
        id: r.rowId,
        role: "assistant",
        snapshotTurnId: r.snapshotTurnId,
      })),
      uiMessages,
    );
    expect(map.get(10)).toBe("2001");
    expect(map.get(11)).toBe("2002");
    expect(map.has(12)).toBe(false);
    expect(map.size).toBe(2);
  });
});
