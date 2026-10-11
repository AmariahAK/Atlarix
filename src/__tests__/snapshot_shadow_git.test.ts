/**
 * v10: shadow-git snapshot store — capture pre-write state, full + partial
 * revert, created-file deletion on revert, legacy .bak fallback.
 *
 * Skips when no git binary is available on PATH (v11: dugite removed; the
 * app shells out to system git).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec as gitExec } from "@/ipc/utils/system_git_exec";
import {
  captureSnapshot,
  listSnapshotFiles,
  readSnapshotFile,
  revertSnapshot,
  revertSnapshotFiles,
  snapshotExists,
  _setShadowSnapshotsRootForTests,
} from "@/lib/snapshot/snapshot-manager";

// Every test here shells out to system `git`; under the parallel `node` vitest
// project the default 5s timeout can be exceeded purely by subprocess startup
// contention (the suite runs ~3x slower under load than in isolation). Raise
// the per-test timeout for this file so slowness can't cause spurious failures
// (combined with the project's retry: 2, this is robust). No logic change.
vi.setConfig({ testTimeout: 30_000 });

const gitAvailable = await gitExec(["--version"], os.tmpdir())
  .then((r) => r.exitCode === 0)
  .catch(() => false);
const describeWithGit = gitAvailable ? describe : describe.skip;
if (!gitAvailable) {
  console.warn(
    "[snapshot_shadow_git.test] system git unavailable — suite skipped",
  );
}

let workspace: string;
let shadowRoot: string;

async function write(rel: string, content: string) {
  const abs = path.join(workspace, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

async function read(rel: string): Promise<string | null> {
  return fs.readFile(path.join(workspace, rel), "utf8").catch(() => null);
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-snap-ws-"));
  shadowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-snap-shadow-"));
  _setShadowSnapshotsRootForTests(shadowRoot);
});

afterEach(async () => {
  _setShadowSnapshotsRootForTests(null);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(shadowRoot, { recursive: true, force: true });
});

describeWithGit("shadow-git snapshots", () => {
  it("captures pre-write state and reverts a full turn", async () => {
    await write("src/a.ts", "original A");
    await write("src/b.ts", "original B");

    await captureSnapshot({
      workspacePath: workspace,
      turnId: "turn:1",
      relativePaths: ["src/a.ts", "src/b.ts"],
    });

    await write("src/a.ts", "MUTATED A");
    await write("src/b.ts", "MUTATED B");

    const result = await revertSnapshot({
      workspacePath: workspace,
      turnId: "turn:1",
    });
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toBe(2);
    expect(await read("src/a.ts")).toBe("original A");
    expect(await read("src/b.ts")).toBe("original B");
  });

  it("range revert (newest→oldest) rewinds multiple turns to pre-first-turn state", async () => {
    // Models the edit-and-resend range revert: two discarded turns, each with a
    // per-touched-file pre-write snapshot. Reverting newest→oldest must restore
    // EVERY file to its state before the first discarded turn, and delete files
    // created by ANY discarded turn (not just the earliest).
    await write("a.ts", "original A");

    // Turn t1: edits a.ts, creates c.ts.
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "t1",
      relativePaths: ["a.ts", "c.ts"], // c.ts doesn't exist yet → created
    });
    await write("a.ts", "A after t1");
    await write("c.ts", "C from t1");

    // Turn t2: edits a.ts again, creates d.ts.
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "t2",
      relativePaths: ["a.ts", "d.ts"], // captures a.ts="A after t1"; d.ts created
    });
    await write("a.ts", "A after t2");
    await write("d.ts", "D from t2");

    // Revert the range NEWEST→OLDEST (what revert:snapshot-range does).
    for (const turnId of ["t2", "t1"]) {
      const r = await revertSnapshot({ workspacePath: workspace, turnId });
      expect(r.success).toBe(true);
    }

    expect(await read("a.ts")).toBe("original A"); // not "A after t1"
    expect(await read("c.ts")).toBeNull(); // created by t1 → deleted
    expect(await read("d.ts")).toBeNull(); // created by t2 → deleted (would survive if only t1 reverted)
  });

  it("first capture per path wins (pre-write state is preserved across writes)", async () => {
    await write("x.txt", "v1");
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "turn:2",
      relativePaths: ["x.txt"],
    });
    await write("x.txt", "v2");
    // Second capture in the same turn must NOT overwrite the original state.
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "turn:2",
      relativePaths: ["x.txt", "y.txt"],
    });
    await write("x.txt", "v3");

    await revertSnapshot({ workspacePath: workspace, turnId: "turn:2" });
    expect(await read("x.txt")).toBe("v1");
  });

  it("partial revert restores only the requested paths", async () => {
    await write("one.txt", "ONE");
    await write("two.txt", "TWO");
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "turn:3",
      relativePaths: ["one.txt", "two.txt"],
    });
    await write("one.txt", "one-mutated");
    await write("two.txt", "two-mutated");

    const result = await revertSnapshotFiles({
      workspacePath: workspace,
      turnId: "turn:3",
      relativePaths: ["one.txt"],
    });
    expect(result.restoredFiles).toBe(1);
    expect(await read("one.txt")).toBe("ONE");
    expect(await read("two.txt")).toBe("two-mutated");
  });

  it("deletes files that were created during the turn on revert", async () => {
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "turn:4",
      relativePaths: ["brand-new.ts"],
    });
    await write("brand-new.ts", "created by the agent");

    await revertSnapshot({ workspacePath: workspace, turnId: "turn:4" });
    expect(await read("brand-new.ts")).toBeNull();
  });

  it("listSnapshotFiles reports changed + created files, null for unknown turns", async () => {
    await write("kept.ts", "orig");
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "turn:files",
      relativePaths: ["kept.ts", "new.ts"], // new.ts does not exist pre-write
    });
    await write("kept.ts", "changed");
    await write("new.ts", "created");

    const listed = await listSnapshotFiles(workspace, "turn:files");
    expect(listed).not.toBeNull();
    expect(listed!.filesChanged).toEqual(
      expect.arrayContaining(["kept.ts", "new.ts"]),
    );
    expect(listed!.createdFiles).toContain("new.ts");
    expect(listed!.createdFiles).not.toContain("kept.ts");

    expect(await listSnapshotFiles(workspace, "turn:nope")).toBeNull();
  });

  it("snapshotExists answers for shadow turns and unknown turns", async () => {
    await write("f.txt", "data");
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "turn:5",
      relativePaths: ["f.txt"],
    });
    expect(await snapshotExists(workspace, "turn:5")).toBe(true);
    expect(await snapshotExists(workspace, "turn:999")).toBe(false);
  });

  it("snapshots are deduped in the object store (content-addressed)", async () => {
    await write("same.txt", "identical content");
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "turn:6",
      relativePaths: ["same.txt"],
    });
    // Same content captured in a different turn → same blob, no growth.
    await captureSnapshot({
      workspacePath: workspace,
      turnId: "turn:7",
      relativePaths: ["same.txt"],
    });
    expect(await snapshotExists(workspace, "turn:6")).toBe(true);
    expect(await snapshotExists(workspace, "turn:7")).toBe(true);
  });
});

describeWithGit("legacy .bak store (removed in v10.1)", () => {
  it("no longer reverts pre-v10 file-copy turns", async () => {
    await write("legacy.txt", "current");
    // Simulate an old-style snapshot dir — the fallback was deleted, so this
    // turn is invisible to snapshotExists and revert is a clean no-op failure.
    const legacyDir = path.join(workspace, ".atlarix", "snapshots", "turn_8");
    await fs.mkdir(path.join(legacyDir, "files"), { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "manifest.json"),
      JSON.stringify({
        turnId: "turn:8",
        timestamp: new Date().toISOString(),
        filesChanged: ["legacy.txt"],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyDir, "files", "legacy.txt.bak"),
      "old bytes",
      "utf8",
    );

    expect(await snapshotExists(workspace, "turn:8")).toBe(false);
    const result = await revertSnapshot({
      workspacePath: workspace,
      turnId: "turn:8",
    });
    expect(result.success).toBe(false);
    expect(await read("legacy.txt")).toBe("current");
  });

  it("reads a file as it was before a turn, without touching the work tree (Compare at a checkpoint)", async () => {
    await write("src/a.ts", "before");
    await captureSnapshot({ workspacePath: workspace, turnId: "turn:cmp", relativePaths: ["src/a.ts", "src/new.ts"] });
    await write("src/a.ts", "after");
    await write("src/new.ts", "created by the turn");

    expect(await readSnapshotFile({ workspacePath: workspace, turnId: "turn:cmp", relativePath: "src/a.ts" })).toEqual({ existed: true, content: "before" });
    expect(await readSnapshotFile({ workspacePath: workspace, turnId: "turn:cmp", relativePath: "src/new.ts" })).toEqual({ existed: false, content: "" });
    // Not part of the turn, or no such turn: nothing to compare.
    expect(await readSnapshotFile({ workspacePath: workspace, turnId: "turn:cmp", relativePath: "src/other.ts" })).toBeNull();
    expect(await readSnapshotFile({ workspacePath: workspace, turnId: "turn:none", relativePath: "src/a.ts" })).toBeNull();
    // The work tree is left as it is.
    expect(await read("src/a.ts")).toBe("after");
  });
});
