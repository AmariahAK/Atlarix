/**
 * Owner, 2026-10-14: "I don't want you guys to revert the work randomly."
 *
 * A revert put every file a turn changed back to its pre-turn state, whatever
 * had happened to it since: an edit by the user, a later turn, or a teammate
 * session was wiped without a word. The turn now records each file as it LEFT
 * it, and a revert keeps (and names) a file that changed after that. A turn
 * with no such record (from before this, or stopped before its end) reverts as
 * before and says it could not check. Every surface's restore (the app's
 * Revert, edit-and-restore, the editor's checkpoint, ACP, the CLI) ends here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec as gitExec } from "@/ipc/utils/system_git_exec";
import {
  captureSnapshot,
  listSnapshotFiles,
  markSnapshotReverted,
  recordSnapshotTurnEnd,
  revertSnapshot,
  takeUntoldRevertedFiles,
  _setShadowSnapshotsRootForTests,
} from "@/lib/snapshot/snapshot-manager";

vi.setConfig({ testTimeout: 30_000 });

const gitAvailable = await gitExec(["--version"], os.tmpdir())
  .then((r) => r.exitCode === 0)
  .catch(() => false);
const describeWithGit = gitAvailable ? describe : describe.skip;

let workspace: string;
let shadowRoot: string;
const at = (rel: string) => path.join(workspace, rel);
const read = (rel: string) => fs.readFile(at(rel), "utf8").catch(() => null);
const write = (rel: string, s: string) => fs.writeFile(at(rel), s, "utf8");

/** A turn: capture, write, end. */
async function turn(id: string, edits: Record<string, string>, opts: { end?: boolean } = {}) {
  await captureSnapshot({ workspacePath: workspace, turnId: id, relativePaths: Object.keys(edits) });
  for (const [rel, s] of Object.entries(edits)) await write(rel, s);
  if (opts.end !== false) await recordSnapshotTurnEnd(id);
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-keep-ws-"));
  shadowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-keep-shadow-"));
  _setShadowSnapshotsRootForTests(shadowRoot);
  await write("a.ts", "a0");
  await write("b.ts", "b0");
});

afterEach(async () => {
  _setShadowSnapshotsRootForTests(null);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(shadowRoot, { recursive: true, force: true });
});

describeWithGit("a revert keeps what changed after the turn", () => {
  it("(a) a file edited since is kept and named; the other goes back", async () => {
    await turn("41", { "a.ts": "a1", "b.ts": "b1" });
    await write("b.ts", "b1 + the user's edit");
    const res = await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    expect(await read("a.ts")).toBe("a0");
    expect(await read("b.ts")).toBe("b1 + the user's edit");
    expect(res.kept).toEqual(["b.ts"]);
    expect(res.restoredFiles).toBe(1);
  });

  it("(b) a file the turn created and someone then changed is kept, not deleted", async () => {
    await turn("41", { "new.ts": "made by the turn" });
    await write("new.ts", "made by the turn + a teammate's edit");
    const res = await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    expect(await read("new.ts")).toBe("made by the turn + a teammate's edit");
    expect(res.kept).toEqual(["new.ts"]);
  });

  it("(c) a file deleted since is kept deleted, not brought back", async () => {
    await turn("41", { "a.ts": "a1" });
    await fs.rm(at("a.ts"));
    const res = await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    expect(await read("a.ts")).toBeNull();
    expect(res.kept).toEqual(["a.ts"]);
  });

  it("(d) the same chat's turns, newest first, still restore fully", async () => {
    await turn("41", { "a.ts": "a1" });
    await turn("42", { "a.ts": "a2", "b.ts": "b2" });
    const r42 = await revertSnapshot({ workspacePath: workspace, turnId: "42" });
    const r41 = await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    expect(await read("a.ts")).toBe("a0");
    expect(await read("b.ts")).toBe("b0");
    expect([...(r42.kept ?? []), ...(r41.kept ?? [])]).toEqual([]);
  });

  it("a later turn's edit is kept when only the earlier turn is reverted", async () => {
    await turn("41", { "a.ts": "a1" });
    await turn("42", { "a.ts": "a2" });
    const res = await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    expect(await read("a.ts")).toBe("a2");
    expect(res.kept).toEqual(["a.ts"]);
  });

  it("an edit landing the moment after the turn ends counts as a change since", async () => {
    await captureSnapshot({ workspacePath: workspace, turnId: "41", relativePaths: ["a.ts"] });
    await write("a.ts", "a1");
    const recorded = recordSnapshotTurnEnd("41"); // the turn's end, not awaited
    await write("a.ts", "a1 + an edit right after");
    await recorded;
    const res = await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    expect(await read("a.ts")).toBe("a1 + an edit right after");
    expect(res.kept).toEqual(["a.ts"]);
  });

  it("nothing changed since: everything goes back (control)", async () => {
    await turn("41", { "a.ts": "a1", "new.ts": "x" });
    const res = await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    expect(await read("a.ts")).toBe("a0");
    expect(await read("new.ts")).toBeNull();
    expect(res.kept).toEqual([]);
    expect(res.unchecked).toBeFalsy();
  });

  it("the agent is told only the files that went back", async () => {
    await turn("41", { "a.ts": "a1", "b.ts": "b1" });
    await write("b.ts", "edited since");
    await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    await markSnapshotReverted(workspace, "41");
    expect(await takeUntoldRevertedFiles(workspace, ["41"])).toEqual(["a.ts"]);
  });
});

describeWithGit("a turn with no record of how it ended", () => {
  it("(e/f) reverts as before, and says it could not check", async () => {
    // From before this change, or stopped/crashed before its end: no end state.
    await turn("41", { "a.ts": "a1" }, { end: false });
    await write("a.ts", "edited since");
    expect((await listSnapshotFiles(workspace, "41"))?.endRecorded).toBe(false);
    const res = await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    expect(await read("a.ts")).toBe("a0");
    expect(res.unchecked).toBe(true);
    expect(res.kept).toEqual([]);
  });

  it("an ended turn lists as checkable (control)", async () => {
    await turn("41", { "a.ts": "a1" });
    expect((await listSnapshotFiles(workspace, "41"))?.endRecorded).toBe(true);
  });
});
