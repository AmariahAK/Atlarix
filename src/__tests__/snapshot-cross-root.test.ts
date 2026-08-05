/**
 * Cross-project revert: a turn that edits this workspace AND a granted sibling reverts
 * both.
 *
 * Before this, outside paths were DROPPED before ever reaching `captureSnapshot`, because
 * it stages a batch with one `git add -f --` at `cwd = workspace` and git aborts the whole
 * invocation on a path outside its work-tree — so a single granted-folder file in a
 * multi-file write destroyed the pre-write snapshot of every in-workspace file beside it.
 * Dropping them fixed that, at the cost of cross-repo edits silently having **no Revert at
 * all**: `edit_file` would happily change a sibling project and nothing recorded the
 * before-state.
 *
 * The fix is one shadow repo per root, each with its own work-tree, so no path is ever
 * outside the repo git is being asked about. The primary workspace's shadow repo records
 * which extra roots took part, so revert has one place to ask what the turn touched.
 *
 * Skips when no git binary is available (the app shells out to system git).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec as gitExec } from "@/ipc/utils/system_git_exec";
import {
  captureSnapshotAcrossRoots,
  groupPathsByRoot,
  listSnapshotFiles,
  revertSnapshot,
  revertSnapshotFiles,
  snapshotExists,
  _setShadowSnapshotsRootForTests,
} from "@/lib/snapshot/snapshot-manager";

vi.setConfig({ testTimeout: 30_000 });

const gitAvailable = await gitExec(["--version"], os.tmpdir())
  .then((r) => r.exitCode === 0)
  .catch(() => false);
const describeWithGit = gitAvailable ? describe : describe.skip;
if (!gitAvailable) {
  console.warn("[snapshot-cross-root.test] system git unavailable — suite skipped");
}

let base: string;
let workspace: string;
let sibling: string;
let ungranted: string;
let shadowRoot: string;

async function put(abs: string, content: string) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
const readOr = (abs: string) => fs.readFile(abs, "utf8").catch(() => null);

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-xroot-")));
  workspace = path.join(base, "workspace");
  sibling = path.join(base, "sibling-repo");
  ungranted = path.join(base, "somewhere-else");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.mkdir(ungranted, { recursive: true });
  shadowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-xroot-shadow-"));
  _setShadowSnapshotsRootForTests(shadowRoot);
});

afterEach(async () => {
  _setShadowSnapshotsRootForTests(null);
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(shadowRoot, { recursive: true, force: true });
});

describe("groupPathsByRoot", () => {
  const ws = path.resolve("/work/project");
  const sib = path.resolve("/work/sibling");

  it("keeps in-workspace paths on the primary root", () => {
    const groups = groupPathsByRoot({
      workspacePath: ws,
      paths: ["src/a.ts", "src/b.ts"],
      grantedRoots: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isPrimary).toBe(true);
    expect(groups[0]!.relativePaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("splits a mixed turn into one group per root", () => {
    const groups = groupPathsByRoot({
      workspacePath: ws,
      paths: ["src/a.ts", path.join(sib, "pkg/loader.go")],
      grantedRoots: [sib],
    });
    expect(groups).toHaveLength(2);
    const primary = groups.find((g) => g.isPrimary)!;
    const outside = groups.find((g) => !g.isPrimary)!;
    expect(primary.relativePaths).toEqual(["src/a.ts"]);
    expect(outside.root).toBe(sib);
    // Root-relative, so the path is never outside the repo git is asked about.
    expect(outside.relativePaths).toEqual(["pkg/loader.go"]);
  });

  it("accepts the '../sibling/x' spelling the UI uses", () => {
    const groups = groupPathsByRoot({
      workspacePath: ws,
      paths: ["../sibling/pkg/loader.go"],
      grantedRoots: [sib],
    });
    expect(groups[0]!.root).toBe(sib);
    expect(groups[0]!.relativePaths).toEqual(["pkg/loader.go"]);
  });

  it("DROPS a path outside every granted root", () => {
    // It could not have been written by an approved edit, and minting a shadow repo for
    // an arbitrary absolute path would scatter git directories across the user's disk.
    const groups = groupPathsByRoot({
      workspacePath: ws,
      paths: ["/etc/hosts", "/tmp/whatever.txt"],
      grantedRoots: [sib],
    });
    expect(groups).toEqual([]);
  });

  it("picks the INNERMOST containing grant", () => {
    // A grant of /work/sibling/pkg inside a grant of /work/sibling must snapshot against
    // the narrower work-tree.
    const inner = path.join(sib, "pkg");
    const groups = groupPathsByRoot({
      workspacePath: ws,
      paths: [path.join(inner, "loader.go")],
      grantedRoots: [sib, inner],
    });
    expect(groups[0]!.root).toBe(inner);
    expect(groups[0]!.relativePaths).toEqual(["loader.go"]);
  });

  it("de-duplicates repeated paths", () => {
    const groups = groupPathsByRoot({
      workspacePath: ws,
      paths: ["src/a.ts", "src/a.ts", path.join(ws, "src/a.ts")],
      grantedRoots: [],
    });
    expect(groups[0]!.relativePaths).toEqual(["src/a.ts"]);
  });
});

describeWithGit("cross-root capture and revert", () => {
  it("reverts a turn that touched the workspace AND a granted sibling", async () => {
    const inside = path.join(workspace, "src/app.ts");
    const outside = path.join(sibling, "pkg/loader.go");
    await put(inside, "original inside");
    await put(outside, "original outside");

    await captureSnapshotAcrossRoots({
      workspacePath: workspace,
      turnId: "turn:1",
      paths: [inside, outside],
      grantedRoots: [sibling],
    });

    await put(inside, "MUTATED inside");
    await put(outside, "MUTATED outside");

    const result = await revertSnapshot({ workspacePath: workspace, turnId: "turn:1" });
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toBe(2);
    expect(await readOr(inside)).toBe("original inside");
    expect(await readOr(outside)).toBe("original outside");
  });

  it("does not let an outside path destroy the in-workspace snapshot", async () => {
    // The regression that made outside paths get dropped in the first place: one outside
    // file in the batch aborted git's whole invocation, so NOTHING was staged.
    const a = path.join(workspace, "a.ts");
    const b = path.join(workspace, "b.ts");
    const outside = path.join(sibling, "c.go");
    await put(a, "A");
    await put(b, "B");
    await put(outside, "C");

    await captureSnapshotAcrossRoots({
      workspacePath: workspace,
      turnId: "turn:2",
      paths: [a, outside, b],
      grantedRoots: [sibling],
    });

    await put(a, "A!");
    await put(b, "B!");
    await put(outside, "C!");

    const result = await revertSnapshot({ workspacePath: workspace, turnId: "turn:2" });
    expect(result.restoredFiles).toBe(3);
    expect(await readOr(a)).toBe("A");
    expect(await readOr(b)).toBe("B");
    expect(await readOr(outside)).toBe("C");
  });

  it("deletes a file the turn CREATED in a granted sibling", async () => {
    const created = path.join(sibling, "pkg/new.go");
    await captureSnapshotAcrossRoots({
      workspacePath: workspace,
      turnId: "turn:3",
      paths: [created],
      grantedRoots: [sibling],
    });
    await put(created, "brand new");

    await revertSnapshot({ workspacePath: workspace, turnId: "turn:3" });
    expect(await readOr(created)).toBeNull();
  });

  it("reverts ONE outside file when asked, using the UI's '../' spelling", async () => {
    const keep = path.join(sibling, "keep.go");
    const undo = path.join(sibling, "undo.go");
    await put(keep, "keep original");
    await put(undo, "undo original");
    await captureSnapshotAcrossRoots({
      workspacePath: workspace,
      turnId: "turn:4",
      paths: [keep, undo],
      grantedRoots: [sibling],
    });
    await put(keep, "keep changed");
    await put(undo, "undo changed");

    const rel = path.relative(workspace, undo).split(path.sep).join("/");
    expect(rel.startsWith("../")).toBe(true); // the shape the revert UI passes
    const result = await revertSnapshotFiles({
      workspacePath: workspace,
      turnId: "turn:4",
      relativePaths: [rel],
    });
    expect(result.success).toBe(true);
    expect(await readOr(undo)).toBe("undo original");
    expect(await readOr(keep)).toBe("keep changed"); // untouched
  });

  it("reports a snapshot for a turn that ONLY touched a sibling", async () => {
    // Checking the primary's manifest alone would hide the Revert affordance for exactly
    // the cross-repo edits this release made revertible.
    const outside = path.join(sibling, "only.go");
    await put(outside, "before");
    await captureSnapshotAcrossRoots({
      workspacePath: workspace,
      turnId: "turn:5",
      paths: [outside],
      grantedRoots: [sibling],
    });
    expect(await snapshotExists(workspace, "turn:5")).toBe(true);
  });

  it("lists outside files with the '../' spelling, round-tripping to revert", async () => {
    const inside = path.join(workspace, "in.ts");
    const outside = path.join(sibling, "out.go");
    await put(inside, "in");
    await put(outside, "out");
    await captureSnapshotAcrossRoots({
      workspacePath: workspace,
      turnId: "turn:6",
      paths: [inside, outside],
      grantedRoots: [sibling],
    });

    const listed = await listSnapshotFiles(workspace, "turn:6");
    expect(listed!.filesChanged).toContain("in.ts");
    const outsideEntry = listed!.filesChanged.find((f) => f.startsWith("../"));
    expect(outsideEntry).toBeTruthy();

    // The listed string must be accepted back by revertSnapshotFiles unchanged.
    await put(outside, "changed");
    const result = await revertSnapshotFiles({
      workspacePath: workspace,
      turnId: "turn:6",
      relativePaths: [outsideEntry!],
    });
    expect(result.success).toBe(true);
    expect(await readOr(outside)).toBe("out");
  });

  it("never snapshots an UNGRANTED outside path", async () => {
    const rogue = path.join(ungranted, "x.txt");
    await put(rogue, "before");
    await captureSnapshotAcrossRoots({
      workspacePath: workspace,
      turnId: "turn:7",
      paths: [rogue],
      grantedRoots: [sibling], // note: `ungranted` is NOT granted
    });

    // No shadow repo was minted for it, and nothing claims to be revertible.
    expect(await snapshotExists(workspace, "turn:7")).toBe(false);
    await put(rogue, "after");
    const result = await revertSnapshot({ workspacePath: workspace, turnId: "turn:7" });
    expect(result.success).toBe(false);
    expect(await readOr(rogue)).toBe("after"); // untouched by revert
  });

  it("keeps each root's history separate across two turns", async () => {
    const inside = path.join(workspace, "a.ts");
    const outside = path.join(sibling, "b.go");
    await put(inside, "v1");
    await put(outside, "v1");

    await captureSnapshotAcrossRoots({
      workspacePath: workspace,
      turnId: "turn:A",
      paths: [inside],
      grantedRoots: [sibling],
    });
    await put(inside, "v2");
    await captureSnapshotAcrossRoots({
      workspacePath: workspace,
      turnId: "turn:B",
      paths: [outside],
      grantedRoots: [sibling],
    });
    await put(outside, "v2");

    // Reverting turn B restores only the sibling file, at its turn-B state.
    await revertSnapshot({ workspacePath: workspace, turnId: "turn:B" });
    expect(await readOr(outside)).toBe("v1");
    expect(await readOr(inside)).toBe("v2"); // turn A not reverted

    await revertSnapshot({ workspacePath: workspace, turnId: "turn:A" });
    expect(await readOr(inside)).toBe("v1");
  });
});
