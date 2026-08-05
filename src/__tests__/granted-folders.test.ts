import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Cross-workspace edits. `run_command` has had escalate-and-grant since v14.15.0;
 * `edit_file` hard-threw at the containment check — AFTER the user had already
 * read and approved the diff — because the two lanes kept disjoint grant lists.
 * Commands read `sandbox_path` DB rows; edits read an in-memory Set that nothing
 * ever seeded from the DB.
 *
 * These pin the unified behaviour and the two blast radii that matter: a grant
 * must not widen beyond the folder, and a revoke must bite immediately.
 */

const granted = new Map<number, string[]>();
/** Every relativePaths batch captureSnapshot was handed. */
const snapshotBatches: string[][] = [];
const snapshotGrantedRoots: string[][] = [];

vi.mock("@/lib/snapshot/snapshot-manager", () => ({
  captureSnapshotAcrossRoots: (args: {
    paths: string[];
    grantedRoots: readonly string[];
  }) => {
    snapshotBatches.push([...args.paths]);
    snapshotGrantedRoots.push([...args.grantedRoots]);
    return Promise.resolve();
  },
}));

vi.mock("@/lib/file-permissions-store", () => ({
  listSandboxWritablePaths: (appId: number) => granted.get(appId) ?? [],
  upsertSandboxWritablePath: (appId: number, p: string) => {
    const cur = granted.get(appId) ?? [];
    if (!cur.includes(p)) cur.push(p);
    granted.set(appId, cur);
  },
  revokeSandboxWritablePath: (appId: number, p: string) => {
    const cur = granted.get(appId) ?? [];
    const i = cur.indexOf(p);
    if (i >= 0) cur.splice(i, 1);
    granted.set(appId, cur);
    return i >= 0;
  },
  listWorkspaceFilePermissions: () => [],
  upsertWorkspaceFilePermission: () => {},
  revokeWorkspaceFilePermission: () => false,
}));

import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import { targetPathsForOperation } from "@/ipc/handlers/permissions/operation-targets";

const APP_ID = 77;
const tmpRoots: string[] = [];

function makeTree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-grant-")));
  tmpRoots.push(base);
  const ws = path.join(base, "Atlarix");
  const sibling = path.join(base, "atlarix-launchpad");
  const unrelated = path.join(base, "some-other-place");
  for (const d of [ws, path.join(sibling, "src"), unrelated]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return { ws, sibling, unrelated };
}

function resolveWrite(ws: string, target: string): string {
  const i = new PermissionInterceptor(ws, APP_ID) as unknown as {
    resolvePathWithinWorkspace: (p: string) => string;
  };
  return i.resolvePathWithinWorkspace(target);
}

afterEach(() => {
  granted.clear();
  snapshotBatches.length = 0;
  snapshotGrantedRoots.length = 0;
  for (const d of tmpRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("granted folders — one list, both lanes", () => {
  it("refuses a sibling repo before any grant", () => {
    const { ws, sibling } = makeTree();
    expect(() => resolveWrite(ws, path.join(sibling, "src", "a.ts"))).toThrow(
      /outside workspace/i,
    );
  });

  it("allows it once the folder is granted", () => {
    const { ws, sibling } = makeTree();
    granted.set(APP_ID, [path.join(sibling, "src")]);
    const target = path.join(sibling, "src", "a.ts");
    expect(resolveWrite(ws, target)).toBe(target);
  });

  // The point of unifying: a grant created by a blocked COMMAND is the same
  // record the editor now reads, so the user is never asked twice for one folder.
  it("a grant made for the command sandbox also authorises edit_file", () => {
    const { ws, sibling } = makeTree();
    granted.set(APP_ID, [sibling]); // as maybeEscalateSandboxDenial would store it
    const target = path.join(sibling, "src", "a.ts");
    expect(resolveWrite(ws, target)).toBe(target);
  });

  it("a grant does NOT widen to the parent or to siblings of the granted folder", () => {
    const { ws, sibling, unrelated } = makeTree();
    granted.set(APP_ID, [path.join(sibling, "src")]);
    // Parent of the granted dir.
    expect(() => resolveWrite(ws, path.join(sibling, "package.json"))).toThrow(
      /outside workspace/i,
    );
    // A different tree entirely.
    expect(() => resolveWrite(ws, path.join(unrelated, "x.ts"))).toThrow(/outside workspace/i);
  });

  // The interceptor re-reads the store per outside-path write rather than
  // caching it at construction, so Settings → Revoke takes effect on the next
  // write instead of the next session.
  it("a revoke bites immediately, in the SAME session", () => {
    const { ws, sibling } = makeTree();
    const dir = path.join(sibling, "src");
    granted.set(APP_ID, [dir]);
    const target = path.join(dir, "a.ts");

    const i = new PermissionInterceptor(ws, APP_ID) as unknown as {
      resolvePathWithinWorkspace: (p: string) => string;
    };
    expect(i.resolvePathWithinWorkspace(target)).toBe(target);

    granted.set(APP_ID, []); // user revokes in Settings
    expect(() => i.resolvePathWithinWorkspace(target)).toThrow(/outside workspace/i);
  });

  // Reading a sibling project by `../` is now allowed (it always was, by
  // absolute path — the rejection was a spelling rule). WRITING there is not:
  // the tool resolves `../` to an absolute path, and that path meets the same
  // grant gate as any other outside target. Spelling changes nothing.
  it("a ../ write still needs the folder granted", () => {
    const { ws, sibling } = makeTree();
    const target = path.join(sibling, "src", "a.ts");
    expect(() => resolveWrite(ws, target)).toThrow(/outside workspace/i);

    granted.set(APP_ID, [path.join(sibling, "src")]);
    expect(resolveWrite(ws, target)).toBe(target);
  });

  it("in-workspace writes are unaffected and never consult the store", () => {
    const { ws } = makeTree();
    const target = path.join(ws, "src", "a.ts");
    expect(resolveWrite(ws, target)).toBe(target);
  });
});

describe("granted folders — blast radius", () => {
  it("a granted folder does NOT inherit the .atlarix blanket auto-approve", () => {
    // `.atlarix/**` auto-approves silently for THIS project's own agent files.
    // A granted sibling renders as `../atlarix-launchpad/.atlarix/…`, which
    // matched the same substring — so the agent could have rewritten another
    // project's hooks.json, executed as shell, with no card shown.
    const { ws, sibling } = makeTree();
    granted.set(APP_ID, [sibling]);
    const i = new PermissionInterceptor(ws, APP_ID) as unknown as {
      shouldAlwaysAutoApprove: (r: unknown) => boolean;
    };
    expect(
      i.shouldAlwaysAutoApprove({
        operation: "write_file",
        preview: { path: path.join(sibling, ".atlarix", "hooks", "hooks.json") },
      }),
    ).toBe(false);
    expect(
      i.shouldAlwaysAutoApprove({
        operation: "write_file",
        preview: { path: path.join(sibling, ".atlarix", "plans", "p.md") },
      }),
    ).toBe(false);
  });

  it("a symlink inside a granted folder cannot escape to an ungranted one", () => {
    const { ws, sibling, unrelated } = makeTree();
    granted.set(APP_ID, [sibling]);
    fs.writeFileSync(path.join(unrelated, "secret.txt"), "x");
    const link = path.join(sibling, "link.txt");
    fs.symlinkSync(path.join(unrelated, "secret.txt"), link);
    expect(() => resolveWrite(ws, link)).toThrow(/symlink/i);
  });

  it("a mixed batch hands over EVERY path plus the granted roots", async () => {
    // History: `captureSnapshot` stages a batch in ONE `git add -f --` at
    // cwd = workspace, and git aborts the entire invocation on a path outside the
    // repo — staging NOTHING, then committing the tree anyway. One granted-folder
    // file therefore discarded the pre-write snapshot of every in-workspace file
    // beside it, so outside paths were filtered out here and this test asserted
    // exactly that: `[["src/a.ts", "src/c.ts"]]`.
    //
    // The cost of that filter was cross-repo edits silently having NO Revert.
    // `captureSnapshotAcrossRoots` removes the cost instead of the paths: it groups
    // by root and captures each against its OWN work-tree, so nothing is ever
    // outside the repo git is asked about. The interceptor's job is now simply to
    // hand over the full list and the grant set — the grouping itself is covered by
    // `snapshot-cross-root.test.ts`.
    const { ws, sibling } = makeTree();
    granted.set(APP_ID, [sibling]);
    const i = new PermissionInterceptor(ws, APP_ID, "turn-1") as unknown as {
      maybeCaptureWorkspaceSnapshot: (rels: string[]) => Promise<void>;
    };
    await i.maybeCaptureWorkspaceSnapshot(["src/a.ts", "../peer/b.ts", "src/c.ts"]);
    // No pre-filtering: the outside path survives to the snapshot layer.
    expect(snapshotBatches).toEqual([["src/a.ts", "../peer/b.ts", "src/c.ts"]]);
    // And the grant set travels with it, so only granted roots can be snapshotted.
    expect(snapshotGrantedRoots[0]).toContain(sibling);
  });

  // Every operation that can touch a path must be collected, or a batch would ask
  // for nothing up front and then throw part-way through with earlier items
  // already applied.
  it("collects targets from every path-bearing operation shape", () => {
    // Extracted out of the interceptor in v14.26.0 — it never read instance
    // state. Exercised directly here; the exhaustive shape cases live in
    // `interceptor-pure-helpers.test.ts`.
    const i = { targetPathsForOperation } as {
      targetPathsForOperation: (r: unknown) => string[];
    };

    expect(
      i.targetPathsForOperation({ operation: "edit_file", preview: { path: "/a/b.ts" } }),
    ).toEqual(["/a/b.ts"]);

    // Rename carries a file ACROSS the boundary — both endpoints matter.
    expect(
      i.targetPathsForOperation({
        operation: "rename_file",
        preview: { fromPath: "/a/old.ts", toPath: "/b/new.ts" },
      }),
    ).toEqual(["/a/old.ts", "/b/new.ts"]);

    expect(
      i.targetPathsForOperation({
        operation: "write_multiple_files",
        preview: [{ path: "/a/1.ts" }, { path: "/a/2.ts" }],
      }),
    ).toEqual(["/a/1.ts", "/a/2.ts"]);

    expect(
      i.targetPathsForOperation({
        operation: "batch_plan",
        preview: {
          title: "x",
          operations: [
            { path: "/a/1.ts" },
            { command: "ls" }, // command sub-ops carry no path
            { fromPath: "/a/2.ts", toPath: "/b/3.ts" },
          ],
        },
      }),
    ).toEqual(["/a/1.ts", "/a/2.ts", "/b/3.ts"]);

    // Non-file operations contribute nothing (and must not recurse: the grant
    // card itself is a sandbox_escalation).
    expect(i.targetPathsForOperation({ operation: "run_command", preview: { command: "ls" } }))
      .toEqual([]);
    expect(
      i.targetPathsForOperation({
        operation: "sandbox_escalation",
        preview: { deniedPath: "/x", grantPath: "/x" },
      }),
    ).toEqual([]);
  });

  it("an all-outside batch still reaches the snapshot layer", async () => {
    // Previously skipped entirely (`[]`), which is precisely how a cross-repo edit
    // ended up with no Revert. Whether anything is actually captured is now decided
    // by the GRANT, in `groupPathsByRoot` — an ungranted path still mints nothing.
    const { ws, sibling } = makeTree();
    granted.set(APP_ID, [sibling]);
    const i = new PermissionInterceptor(ws, APP_ID, "turn-1") as unknown as {
      maybeCaptureWorkspaceSnapshot: (rels: string[]) => Promise<void>;
    };
    await i.maybeCaptureWorkspaceSnapshot(["../peer/b.ts"]);
    expect(snapshotBatches).toEqual([["../peer/b.ts"]]);
  });
});
