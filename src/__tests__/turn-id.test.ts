/**
 * Turn ids carry the process that ran the turn (audit 1f): message ids are
 * seeded from the clock in every process, so two Atlarix processes starting a
 * turn in the same millisecond shared a turn id and, in one folder, a snapshot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { messageIdOfTurn, turnIdForMessage } from "@/shared/turn-id";
import { _setShadowSnapshotsRootForTests, captureSnapshot, listSnapshotFiles } from "@/lib/snapshot/snapshot-manager";

describe("a turn id", () => {
  it("names its message, with the process after it", () => {
    expect(turnIdForMessage(1792511776431, 4242)).toBe("1792511776431-4242");
    expect(messageIdOfTurn("1792511776431-4242")).toBe(1792511776431);
  });

  it("reads one from before the pid was added, and nothing else", () => {
    expect(messageIdOfTurn("1792511776431")).toBe(1792511776431);
    for (const bad of ["", null, undefined, "turn:3", "12-ab", "-1"]) expect(messageIdOfTurn(bad)).toBeNull();
  });
});

describe("finding a turn's snapshot by its message id", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-turnid-ws-"));
    _setShadowSnapshotsRootForTests(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-turnid-shadow-")));
    fs.writeFileSync(path.join(ws, "a.ts"), "one");
  });
  afterEach(() => _setShadowSnapshotsRootForTests(null));

  it("a stopped turn's client has only the message id: it finds this process's turn", async () => {
    await captureSnapshot({ workspacePath: ws, turnId: turnIdForMessage(500, process.pid), relativePaths: ["a.ts"] });
    expect((await listSnapshotFiles(ws, "500"))?.filesChanged).toEqual(["a.ts"]);
  });

  it("a turn recorded before the pid was added is still found by its own id", async () => {
    await captureSnapshot({ workspacePath: ws, turnId: "600", relativePaths: ["a.ts"] });
    expect((await listSnapshotFiles(ws, "600"))?.filesChanged).toEqual(["a.ts"]);
  });

  it("another process's turn for the same message id is not this one's", async () => {
    await captureSnapshot({ workspacePath: ws, turnId: turnIdForMessage(700, process.pid + 1), relativePaths: ["a.ts"] });
    expect(await listSnapshotFiles(ws, "700")).toBeNull();
  });
});
