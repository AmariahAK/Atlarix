import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// These are real-git-subprocess integration tests (init/worktree/read-tree/
// commit-tree). Under full-suite parallel load they can exceed the 5s default,
// so give the git-heavy cases a realistic budget.
const GIT_IO_TIMEOUT_MS = 30_000;
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec } from "@/ipc/utils/system_git_exec";

// getUserDataPath needs Electron's app — point it at a temp dir for the test.
let userData: string;
vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => userData,
}));

import {
  createSubagentWorktree,
  captureWorktreeDiff,
  removeSubagentWorktree,
  isPathInActiveSubagentWorktree,
  isGitRepo,
  applyEditProposalToWorktree,
} from "@/lib/agents/subagent-worktree";

/** Mimics the `__permission_required` proposal edit_file returns (all ops). */
function editProposal(relPath: string, content: string, type: "create" | "update") {
  return {
    __permission_required: true as const,
    operation: "edit_file",
    preview: { path: relPath, content, type, lines: content.split("\n").length },
  };
}

let workspace: string;
let nonGit: string;

async function initRepo(dir: string) {
  await exec(["init"], dir);
  await exec(["config", "user.email", "t@example.com"], dir);
  await exec(["config", "user.name", "Test"], dir);
  // Windows CI: the runner's global core.autocrlf converts worktree checkouts to
  // CRLF, breaking exact-content assertions. Pin LF for these test repos.
  await exec(["config", "core.autocrlf", "false"], dir);
  await writeFile(path.join(dir, "app.ts"), "export const a = 1;\n");
  await exec(["add", "-A"], dir);
  await exec(["commit", "-m", "init"], dir);
}

describe("subagent worktree isolation", () => {
  beforeAll(async () => {
    userData = await mkdtemp(path.join(tmpdir(), "atlarix-ud-"));
    workspace = await mkdtemp(path.join(tmpdir(), "atlarix-ws-"));
    nonGit = await mkdtemp(path.join(tmpdir(), "atlarix-ng-"));
    await initRepo(workspace);
  }, GIT_IO_TIMEOUT_MS);

  afterAll(async () => {
    for (const d of [userData, workspace, nonGit]) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  }, GIT_IO_TIMEOUT_MS);

  it("detects git vs non-git workspaces", async () => {
    expect(await isGitRepo(workspace)).toBe(true);
    expect(await isGitRepo(nonGit)).toBe(false);
  });

  it("returns null (scout fallback) for a non-git workspace", async () => {
    expect(await createSubagentWorktree(nonGit, "task-1")).toBeNull();
  });

  it("creates an isolated worktree, captures its diff, and cleans up", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    const wt = await createSubagentWorktree(workspace, "task-abc");
    expect(wt).not.toBeNull();
    if (!wt) return;

    // Worktree exists and is registered.
    expect((await stat(wt.worktreePath)).isDirectory()).toBe(true);
    const inside = path.join(wt.worktreePath, "new.ts");
    expect(isPathInActiveSubagentWorktree(inside)).toBe(true);
    expect(isPathInActiveSubagentWorktree(path.join(workspace, "app.ts"))).toBe(false);

    // A writer edits inside the worktree only — the real workspace is untouched.
    await writeFile(inside, "export const b = 2;\n");
    await writeFile(path.join(wt.worktreePath, "app.ts"), "export const a = 99;\n");

    const diff = await captureWorktreeDiff(wt);
    expect(diff.changedFiles.sort()).toEqual(["app.ts", "new.ts"]);
    expect(diff.unifiedDiff).toContain("new.ts");
    expect(diff.unifiedDiff).toContain("export const b = 2;");

    // Real workspace file is unchanged until the main agent merges the diff.
    expect(await readFile(path.join(workspace, "app.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );

    await removeSubagentWorktree(workspace, wt);
    expect(isPathInActiveSubagentWorktree(inside)).toBe(false);
    await expect(stat(wt.worktreePath)).rejects.toBeTruthy(); // gone
  });

  it("isolates concurrent writers in separate worktrees", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    const [a, b] = await Promise.all([
      createSubagentWorktree(workspace, "task-x"),
      createSubagentWorktree(workspace, "task-y"),
    ]);
    expect(a && b).toBeTruthy();
    if (!a || !b) return;
    expect(a.worktreePath).not.toBe(b.worktreePath);
    await writeFile(path.join(a.worktreePath, "x.ts"), "x");
    await writeFile(path.join(b.worktreePath, "y.ts"), "y");
    const [da, db] = await Promise.all([captureWorktreeDiff(a), captureWorktreeDiff(b)]);
    expect(da.changedFiles).toContain("x.ts");
    expect(da.changedFiles).not.toContain("y.ts"); // no cross-talk
    expect(db.changedFiles).toContain("y.ts");
    await Promise.all([
      removeSubagentWorktree(workspace, a),
      removeSubagentWorktree(workspace, b),
    ]);
  });
});

describe("subagent worktree seeds from the live working tree", () => {
  beforeAll(async () => {
    userData = await mkdtemp(path.join(tmpdir(), "atlarix-ud2-"));
  }, GIT_IO_TIMEOUT_MS);
  afterAll(async () => {
    await rm(userData, { recursive: true, force: true }).catch(() => {});
  });

  it("sees uncommitted + untracked-not-ignored work, excludes ignored, and diffs only the sub-agent's changes", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "atlarix-seed-"));
    try {
      await initRepo(ws); // commits app.ts = "export const a = 1;\n"

      // Uncommitted state the writer MUST see (the bug: HEAD seed missed these).
      await writeFile(path.join(ws, "app.ts"), "export const a = 2;\n"); // tracked-modified
      await writeFile(path.join(ws, "untracked.ts"), "export const u = 1;\n"); // untracked-not-ignored
      await writeFile(path.join(ws, ".gitignore"), "ignored.ts\n");
      await writeFile(path.join(ws, "ignored.ts"), "secret\n"); // ignored → must NOT seed

      const wt = await createSubagentWorktree(ws, "seed-task");
      expect(wt).not.toBeNull();
      if (!wt) return;

      // Worktree reflects the working tree: modified + untracked present, ignored absent.
      expect(await readFile(path.join(wt.worktreePath, "app.ts"), "utf8")).toBe(
        "export const a = 2;\n",
      );
      expect(
        await readFile(path.join(wt.worktreePath, "untracked.ts"), "utf8"),
      ).toBe("export const u = 1;\n");
      await expect(
        stat(path.join(wt.worktreePath, "ignored.ts")),
      ).rejects.toBeTruthy();

      // The sub-agent makes its OWN change on top of the snapshot.
      await writeFile(
        path.join(wt.worktreePath, "agent-new.ts"),
        "export const g = 1;\n",
      );

      // Captured diff = ONLY the sub-agent's change (not the pre-existing
      // uncommitted work, which already lives in the real workspace).
      const diff = await captureWorktreeDiff(wt);
      expect(diff.changedFiles).toEqual(["agent-new.ts"]);
      expect(diff.changedFiles).not.toContain("app.ts");
      expect(diff.changedFiles).not.toContain("untracked.ts");

      // Real workspace untouched by the sub-agent.
      expect(await readFile(path.join(ws, "app.ts"), "utf8")).toBe(
        "export const a = 2;\n",
      );
      await expect(stat(path.join(ws, "agent-new.ts"))).rejects.toBeTruthy();

      await removeSubagentWorktree(ws, wt);
    } finally {
      await rm(ws, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("seeds a zero-commit repo from its working tree (root seed commit)", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "atlarix-empty-"));
    try {
      await exec(["init"], ws);
      await exec(["config", "user.email", "t@example.com"], ws);
      await exec(["config", "user.name", "Test"], ws);
      await exec(["config", "core.autocrlf", "false"], ws); // Windows CI: pin LF
      await writeFile(path.join(ws, "fresh.ts"), "export const f = 1;\n"); // untracked, no HEAD

      const wt = await createSubagentWorktree(ws, "empty-task");
      expect(wt).not.toBeNull();
      if (!wt) return;
      expect(await readFile(path.join(wt.worktreePath, "fresh.ts"), "utf8")).toBe(
        "export const f = 1;\n",
      );
      await removeSubagentWorktree(ws, wt);
    } finally {
      await rm(ws, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("applyEditProposalToWorktree — writer edits actually land", () => {
  beforeAll(async () => {
    userData = await mkdtemp(path.join(tmpdir(), "atlarix-ud3-"));
  }, GIT_IO_TIMEOUT_MS);
  afterAll(async () => {
    await rm(userData, { recursive: true, force: true }).catch(() => {});
  });

  it("applies an edit_file proposal so captureWorktreeDiff is non-empty (end-to-end)", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "atlarix-apply-"));
    try {
      await initRepo(ws); // app.ts = "export const a = 1;\n"
      const wt = await createSubagentWorktree(ws, "apply-task");
      expect(wt).not.toBeNull();
      if (!wt) return;

      // Regression: before the fix the sub-agent's edit_file only produced a
      // preview and nothing wrote it → the worktree stayed empty → empty diff.
      const applied = await applyEditProposalToWorktree(
        wt.worktreePath,
        editProposal("src/new.ts", "export const b = 2;\n", "create"),
      );
      expect(applied).toEqual({ path: "src/new.ts", type: "create", lines: 2 });

      // File exists in the worktree (dirs auto-created).
      expect(await readFile(path.join(wt.worktreePath, "src/new.ts"), "utf8")).toBe(
        "export const b = 2;\n",
      );

      // The core assertion: the writer's edit now shows up in the captured diff.
      const diff = await captureWorktreeDiff(wt);
      expect(diff.changedFiles).toContain("src/new.ts");
      expect(diff.unifiedDiff).toContain("export const b = 2;");

      await removeSubagentWorktree(ws, wt);
    } finally {
      await rm(ws, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns null for a non-proposal result (caller passes it through)", async () => {
    expect(await applyEditProposalToWorktree("/tmp/x", { success: true })).toBeNull();
    expect(await applyEditProposalToWorktree("/tmp/x", "plain text")).toBeNull();
    expect(
      await applyEditProposalToWorktree("/tmp/x", {
        __permission_required: true,
        preview: { path: "a.ts" }, // no content → not applicable
      }),
    ).toBeNull();
  });

  it("rejects a path that escapes the worktree (defense-in-depth)", async () => {
    await expect(
      applyEditProposalToWorktree(
        "/tmp/wt-root",
        editProposal("../../etc/evil", "x", "create"),
      ),
    ).rejects.toThrow(/escapes worktree/);
  });
});
