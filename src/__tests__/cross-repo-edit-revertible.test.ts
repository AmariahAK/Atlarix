/**
 * A cross-repo edit is revertible END TO END, through the real interceptor.
 *
 * The unit coverage in `snapshot-cross-root.test.ts` proves the snapshot store handles
 * multiple roots. This proves the wiring: that an `edit_file` approval targeting a granted
 * folder actually reaches `captureSnapshotAcrossRoots` with the right root, rather than
 * having its path dropped on the way (which is what happened before — outside paths were
 * filtered out of capture, so a cross-repo edit silently had no Revert while the UI gave
 * no indication of that).
 *
 * Skips when no git binary is available (the app shells out to system git).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec as gitExec } from "@/ipc/utils/system_git_exec";
import {
  listSnapshotFiles,
  revertSnapshot,
  snapshotExists,
  _setShadowSnapshotsRootForTests,
} from "@/lib/snapshot/snapshot-manager";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";

vi.setConfig({ testTimeout: 30_000 });

const gitAvailable = await gitExec(["--version"], os.tmpdir())
  .then((r) => r.exitCode === 0)
  .catch(() => false);
const describeWithGit = gitAvailable ? describe : describe.skip;

let base = "";
let workspace = "";
let sibling = "";
let shadowRoot = "";

const TURN = "turn:xrepo";

async function put(abs: string, content: string) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
const readOr = (abs: string) => fs.readFile(abs, "utf8").catch(() => null);

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-xrepo-")));
  workspace = path.join(base, "workspace");
  sibling = path.join(base, "sibling-repo");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  shadowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-xrepo-shadow-"));
  _setShadowSnapshotsRootForTests(shadowRoot);
});

afterEach(async () => {
  _setShadowSnapshotsRootForTests(null);
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(shadowRoot, { recursive: true, force: true });
});

/**
 * An interceptor with the sibling pre-granted, mirroring the state after the user has
 * approved that folder once.
 */
function interceptorWithGrant(): PermissionInterceptor {
  const it = new PermissionInterceptor(workspace, undefined, TURN);
  // `allowedRoots` is the in-memory grant set the DB rows also feed (there is no DB here).
  (it as unknown as { allowedRoots: Set<string> }).allowedRoots.add(sibling);
  return it;
}

describeWithGit("cross-repo edit is revertible through the interceptor", () => {
  it("snapshots and reverts a write to a granted sibling", async () => {
    const outside = path.join(sibling, "pkg/loader.go");
    await put(outside, 'const Version = "1"');

    const interceptor = interceptorWithGrant();
    await (
      interceptor as unknown as {
        maybeCaptureWorkspaceSnapshot: (p: string[]) => Promise<void>;
        toWorkspaceRelativePosix: (p: string) => string;
      }
    ).maybeCaptureWorkspaceSnapshot([
      (
        interceptor as unknown as { toWorkspaceRelativePosix: (p: string) => string }
      ).toWorkspaceRelativePosix(outside),
    ]);

    await put(outside, 'const Version = "2"');

    expect(await snapshotExists(workspace, TURN)).toBe(true);
    const result = await revertSnapshot({ workspacePath: workspace, turnId: TURN });
    expect(result.success).toBe(true);
    expect(await readOr(outside)).toBe('const Version = "1"');
  });

  it("snapshots a mixed batch without losing the in-workspace file", async () => {
    const inside = path.join(workspace, "src/app.ts");
    const outside = path.join(sibling, "lib.go");
    await put(inside, "inside v1");
    await put(outside, "outside v1");

    const interceptor = interceptorWithGrant();
    const rel = (p: string) =>
      (
        interceptor as unknown as { toWorkspaceRelativePosix: (x: string) => string }
      ).toWorkspaceRelativePosix(p);
    await (
      interceptor as unknown as {
        maybeCaptureWorkspaceSnapshot: (p: string[]) => Promise<void>;
      }
    ).maybeCaptureWorkspaceSnapshot([rel(inside), rel(outside)]);

    await put(inside, "inside v2");
    await put(outside, "outside v2");

    const listed = await listSnapshotFiles(workspace, TURN);
    expect(listed!.filesChanged).toContain("src/app.ts");
    expect(listed!.filesChanged.some((f) => f.startsWith("../"))).toBe(true);

    const result = await revertSnapshot({ workspacePath: workspace, turnId: TURN });
    expect(result.restoredFiles).toBe(2);
    expect(await readOr(inside)).toBe("inside v1");
    expect(await readOr(outside)).toBe("outside v1");
  });
});
