/**
 * QA (app) #1: Revert on a reply put the files back, but nothing remembered it.
 * A reopened chat offered Revert again, and the agent was never told, so its
 * next turn built on edits that were gone. The revert is now recorded with the
 * turn's snapshot, and the agent is told once.
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

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-rev-ws-"));
  shadowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-rev-shadow-"));
  _setShadowSnapshotsRootForTests(shadowRoot);
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src/tally.js"), "before", "utf8");
  await captureSnapshot({ workspacePath: workspace, turnId: "41", relativePaths: ["src/tally.js"] });
  await fs.writeFile(path.join(workspace, "src/tally.js"), "after", "utf8");
});

afterEach(async () => {
  _setShadowSnapshotsRootForTests(null);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(shadowRoot, { recursive: true, force: true });
});

describeWithGit("a reverted turn is remembered", () => {
  it("is not reverted until it is", async () => {
    expect((await listSnapshotFiles(workspace, "41"))?.revertedAt).toBeUndefined();
    expect(await takeUntoldRevertedFiles(workspace, ["41"])).toEqual([]);
  });

  it("shows as reverted afterwards (a reopened chat reads this)", async () => {
    await revertSnapshot({ workspacePath: workspace, turnId: "41" });
    await markSnapshotReverted(workspace, "41");
    const listed = await listSnapshotFiles(workspace, "41");
    expect(listed?.revertedAt).toBeTruthy();
    expect(listed?.filesChanged).toEqual(["src/tally.js"]);
  });

  it("the agent is told once, and again after a second revert", async () => {
    await markSnapshotReverted(workspace, "41");
    expect(await takeUntoldRevertedFiles(workspace, ["41", "99"])).toEqual(["src/tally.js"]);
    expect(await takeUntoldRevertedFiles(workspace, ["41"])).toEqual([]);
    await markSnapshotReverted(workspace, "41");
    expect(await takeUntoldRevertedFiles(workspace, ["41"])).toEqual(["src/tally.js"]);
  });
});
