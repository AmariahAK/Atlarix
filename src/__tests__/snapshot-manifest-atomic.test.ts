/**
 * A turn's manifest is rewritten at its end (how it left each file) and is
 * read without the workspace lock (the files list, the revert preview). A
 * plain writeFile empties the file first, so a reader landing in that gap saw
 * no manifest at all: the agent-eval "revert turn" failed 1 run in 5 with the
 * turn's files list null right after the turn (2026-10-14).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec as gitExec } from "@/ipc/utils/system_git_exec";
import {
  captureSnapshot,
  listSnapshotFiles,
  markSnapshotReverted,
  recordSnapshotTurnEnd,
  snapshotExists,
  _setShadowSnapshotsRootForTests,
} from "@/lib/snapshot/snapshot-manager";

vi.setConfig({ testTimeout: 60_000 });

const gitAvailable = await gitExec(["--version"], os.tmpdir())
  .then((r) => r.exitCode === 0)
  .catch(() => false);
const describeWithGit = gitAvailable ? describe : describe.skip;

let workspace: string;
let shadowRoot: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-atomic-ws-"));
  shadowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-atomic-shadow-"));
  _setShadowSnapshotsRootForTests(shadowRoot);
  // A manifest big enough that writing it takes more than an instant.
  for (let i = 0; i < 200; i++) await fs.writeFile(path.join(workspace, `f${i}.ts`), `v${i}`);
});

afterEach(async () => {
  _setShadowSnapshotsRootForTests(null);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(shadowRoot, { recursive: true, force: true });
});

describeWithGit("a turn's manifest while it is rewritten", () => {
  it("is never read as missing", async () => {
    const files = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
    await captureSnapshot({ workspacePath: workspace, turnId: "t1", relativePaths: files });
    for (const f of files) await fs.writeFile(path.join(workspace, f), `changed ${f}`);

    let stop = false;
    let missing = 0;
    let reads = 0;
    // listSnapshotFiles waits for queued writes; snapshotExists (the Revert
    // button) reads straight away, so it is the one that can land mid-write.
    const reader = (async () => {
      while (!stop) {
        const [listed, exists] = await Promise.all([
          listSnapshotFiles(workspace, "t1"),
          snapshotExists(workspace, "t1"),
        ]);
        reads++;
        if (!listed) missing++;
        if (!exists) missing++;
      }
    })();
    // Rewrites: the turn's end, then repeated revert marks.
    await recordSnapshotTurnEnd("t1");
    for (let i = 0; i < 40; i++) await markSnapshotReverted(workspace, "t1");
    stop = true;
    await reader;

    expect(reads).toBeGreaterThan(10);
    expect(missing).toBe(0);
  });
});
