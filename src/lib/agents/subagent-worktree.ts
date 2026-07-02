/**
 * Isolated git worktrees for *writing* sub-agents.
 *
 * A read-only scout works directly in the workspace. A writing sub-agent
 * (`task({ write: true })`) instead works inside a throwaway git worktree
 * checked out from HEAD, so its edits/commands are confined to a disposable
 * tree and never touch the user's files until reviewed. On completion we
 * capture the worktree's diff and hand it back to the main agent, which lands
 * the changes through its own (approval-gated) write tools. The worktree is
 * always removed afterwards.
 *
 * Confinement is layered: file tools resolve paths under the worktree
 * (`resolvePathUnderWorkspace`), `run_command` is sandboxed to the worktree,
 * and `isPathInActiveSubagentWorktree` is exported as a defense-in-depth check.
 *
 * Requires the workspace to be a git repo; otherwise writer mode is unavailable
 * and the caller falls back to a read-only scout. The worktree is seeded from a
 * snapshot of the CURRENT WORKING TREE (tracked-modified + untracked-not-ignored,
 * built through a throwaway index so the user's real index/working tree are never
 * touched), so a writer DOES see the user's and the main agent's *uncommitted*
 * edits. The captured diff is taken against that snapshot, so it contains only
 * the sub-agent's own changes (the pre-existing uncommitted work already lives in
 * the real workspace and must not be re-applied).
 */

import path from "node:path";
import { rm, readdir, mkdir, writeFile } from "node:fs/promises";
import log from "electron-log";
import { exec } from "@/ipc/utils/system_git_exec";
import { getUserDataPath } from "@/paths/paths";
import {
  ATLARIX_GIT_AUTHOR_NAME,
  ATLARIX_GIT_AUTHOR_EMAIL,
} from "@/ipc/utils/git_author";

const logger = log.scope("subagent-worktree");

/** Absolute, normalized roots of worktrees currently in use. */
const activeWorktreeRoots = new Set<string>();

/** Monotonic counter for unique throwaway seed-index filenames. */
let taskCounter = 0;

export interface SubagentWorktree {
  worktreePath: string;
  /**
   * Commit the worktree was seeded from — a working-tree snapshot commit
   * (or bare HEAD if the snapshot couldn't be built). `captureWorktreeDiff`
   * diffs against this, so the diff is exactly the sub-agent's own changes.
   */
  baseRef: string;
}

export interface WorktreeDiff {
  /** Workspace-relative paths the sub-agent changed. */
  changedFiles: string[];
  /** Unified diff against the base commit (empty string if no changes). */
  unifiedDiff: string;
}

function norm(p: string): string {
  return path.resolve(p);
}

/** True when the path is inside a worktree we currently own (defense-in-depth). */
export function isPathInActiveSubagentWorktree(absPath: string): boolean {
  const p = norm(absPath);
  for (const root of activeWorktreeRoots) {
    if (p === root || p.startsWith(root + path.sep)) return true;
  }
  return false;
}

export async function isGitRepo(workspacePath: string): Promise<boolean> {
  const r = await exec(["rev-parse", "--is-inside-work-tree"], workspacePath);
  return r.exitCode === 0 && r.stdout.trim() === "true";
}

/** Workspace-keyed directory holding this workspace's sub-agent worktrees. */
function worktreeDirForWorkspace(workspacePath: string): string {
  const workspaceKey = norm(workspacePath).replace(/[^a-zA-Z0-9]/g, "_").slice(-64);
  return path.join(getUserDataPath(), "subagent-worktrees", workspaceKey);
}

/**
 * Remove worktrees orphaned by a crashed/killed writer sub-agent (the process
 * died before `removeSubagentWorktree` ran), leaving a leaked dir and a stale
 * entry in the repo's worktree registry. Idempotent and best-effort: prunes the
 * registry, drops leftover dirs not in use this session, prunes again. Called
 * before creating a new worktree so leaks never accumulate.
 */
export async function cleanupStaleSubagentWorktrees(
  workspacePath: string,
): Promise<void> {
  try {
    if (!(await isGitRepo(workspacePath))) return;
    await exec(["worktree", "prune"], workspacePath).catch(() => {});
    const dir = worktreeDirForWorkspace(workspacePath);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (activeWorktreeRoots.has(norm(full))) continue; // owned this session
      await exec(["worktree", "remove", "--force", full], workspacePath).catch(
        () => {},
      );
      await rm(full, { recursive: true, force: true }).catch(() => {});
    }
    await exec(["worktree", "prune"], workspacePath).catch(() => {});
  } catch (e) {
    logger.debug("stale sub-agent worktree cleanup skipped:", e);
  }
}

/**
 * Build a commit object capturing the CURRENT WORKING TREE — tracked
 * modifications, deletions, AND untracked-but-not-ignored files — without
 * touching the user's real index or working tree. Uses a throwaway
 * `GIT_INDEX_FILE` and git plumbing (read-tree → add -A → write-tree →
 * commit-tree), the same pattern the snapshot manager uses. `git add -A`
 * respects `.gitignore` (no `-f`), so ignored files stay out. Returns the
 * seed commit SHA, or null on any failure (caller falls back to bare HEAD).
 */
async function buildWorkingTreeSeedCommit(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const tmpIndex = path.join(
    worktreeDirForWorkspace(workspacePath),
    `.seed-index-${process.pid}-${taskCounter++}`,
  );
  await mkdir(path.dirname(tmpIndex), { recursive: true }).catch(() => {});
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const head = await exec(
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      workspacePath,
      { signal },
    );
    const headSha =
      head.exitCode === 0 ? head.stdout.trim() : "";
    const hasHead = headSha !== "";

    const readTree = await exec(
      hasHead ? ["read-tree", headSha] : ["read-tree", "--empty"],
      workspacePath,
      { env, signal },
    );
    if (readTree.exitCode !== 0) return null;

    // Stage the full working tree (modifications, additions, deletions) into the
    // throwaway index; untracked-not-ignored included, ignored excluded.
    const add = await exec(["add", "-A"], workspacePath, { env, signal });
    if (add.exitCode !== 0) return null;

    const writeTree = await exec(["write-tree"], workspacePath, { env, signal });
    const tree = writeTree.stdout.trim();
    if (writeTree.exitCode !== 0 || !tree) return null;

    // commit-tree needs an identity; supply the agent's so we never touch or
    // depend on the user's git config.
    const commitEnv = {
      ...env,
      GIT_AUTHOR_NAME: ATLARIX_GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: ATLARIX_GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: ATLARIX_GIT_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: ATLARIX_GIT_AUTHOR_EMAIL,
    };
    const commit = await exec(
      hasHead
        ? ["commit-tree", tree, "-p", headSha, "-m", "atlarix writer seed"]
        : ["commit-tree", tree, "-m", "atlarix writer seed"],
      workspacePath,
      { env: commitEnv, signal },
    );
    const seed = commit.stdout.trim();
    if (commit.exitCode !== 0 || !seed) return null;
    return seed;
  } catch (e) {
    logger.warn("working-tree seed commit failed — falling back to HEAD:", e);
    return null;
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/**
 * Create an isolated worktree for a writing sub-agent, or null when the
 * workspace is not a git repo (caller falls back to a read-only scout).
 */
export async function createSubagentWorktree(
  workspacePath: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<SubagentWorktree | null> {
  if (!(await isGitRepo(workspacePath))) {
    logger.info("Workspace is not a git repo — writer sub-agent unavailable");
    return null;
  }

  // Reap any worktrees a previously-crashed writer left behind before adding one.
  await cleanupStaleSubagentWorktrees(workspacePath);

  // Seed from the current working tree so the writer sees uncommitted work;
  // degrade to bare HEAD if the snapshot can't be built. Signal-threaded so a
  // user cancel kills the (potentially heavy) staging git children promptly.
  let baseRef = await buildWorkingTreeSeedCommit(workspacePath, signal);
  if (!baseRef) {
    const head = await exec(["rev-parse", "HEAD"], workspacePath, { signal });
    if (head.exitCode !== 0) {
      logger.warn(
        "Could not resolve HEAD — writer sub-agent unavailable:",
        head.stderr.trim(),
      );
      return null;
    }
    baseRef = head.stdout.trim();
    logger.warn("Working-tree seed unavailable — worktree seeded from HEAD");
  }

  // Unique, sanitized worktree path under userData (never inside the workspace).
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, "");
  const worktreePath = path.join(worktreeDirForWorkspace(workspacePath), safeId);

  const add = await exec(
    ["worktree", "add", "--detach", worktreePath, baseRef],
    workspacePath,
    { signal },
  );
  if (add.exitCode !== 0) {
    logger.warn("git worktree add failed — writer sub-agent unavailable:", add.stderr.trim());
    // Best-effort cleanup of a partial worktree.
    await exec(["worktree", "remove", "--force", worktreePath], workspacePath);
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    return null;
  }

  activeWorktreeRoots.add(norm(worktreePath));
  logger.info(`Created sub-agent worktree at ${worktreePath} (base ${baseRef.slice(0, 8)})`);
  return { worktreePath, baseRef };
}

/** Result of applying one `edit_file` proposal into a writer's worktree. */
export interface AppliedEdit {
  /** Workspace-relative path written. */
  path: string;
  /** Whether the file already existed (update) or was newly created. */
  type: "create" | "update";
  /** Line count of the written body. */
  lines: number;
}

/**
 * Apply an `edit_file` proposal into a writer sub-agent's isolated worktree.
 *
 * `edit_file` never writes files itself — it returns a `__permission_required`
 * proposal whose `preview.content` is the full resolved file body (true for all
 * five ops: write/replace/insert/delete/section). In the MAIN chat the approval
 * interceptor performs the real `fs.writeFile`; a writer sub-agent has no such
 * interceptor, so without this the worktree stays untouched, `captureWorktreeDiff`
 * returns empty, and the model wrongly believes it edited. Here we apply the
 * proposal straight into the throwaway worktree — which IS the review surface: the
 * captured diff is handed back and re-approved through the main agent's gate.
 *
 * Returns a compact applied-summary, or null when `result` is not an apply-able
 * edit proposal (caller passes the original result through unchanged). Throws if
 * the resolved path escapes the worktree (defense-in-depth).
 */
export async function applyEditProposalToWorktree(
  worktreePath: string,
  result: unknown,
): Promise<AppliedEdit | null> {
  if (
    !result ||
    typeof result !== "object" ||
    (result as { __permission_required?: boolean }).__permission_required !== true
  ) {
    return null;
  }
  const preview = (result as {
    preview?: { path?: string; content?: string; type?: string };
  }).preview;
  const rel = preview?.path;
  if (!rel || typeof preview?.content !== "string") return null;

  // Confinement: reject anything that resolves outside the worktree.
  const root = norm(worktreePath);
  const fullPath = path.resolve(worktreePath, rel);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
    throw new Error(`edit path escapes worktree: ${rel}`);
  }

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, preview.content, "utf-8");
  return {
    path: rel,
    type: preview.type === "update" ? "update" : "create",
    lines: preview.content.split("\n").length,
  };
}

/** Stage everything in the worktree and diff it against the base commit. */
export async function captureWorktreeDiff(
  wt: SubagentWorktree,
  signal?: AbortSignal,
): Promise<WorktreeDiff> {
  await exec(["add", "-A"], wt.worktreePath, { signal });
  const [names, diff] = await Promise.all([
    exec(["diff", "--cached", "--name-only", wt.baseRef], wt.worktreePath, { signal }),
    exec(["diff", "--cached", wt.baseRef], wt.worktreePath, { signal }),
  ]);
  const changedFiles = names.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { changedFiles, unifiedDiff: diff.stdout };
}

/** Remove the worktree and its files. Always safe to call (idempotent). */
export async function removeSubagentWorktree(
  workspacePath: string,
  wt: SubagentWorktree,
): Promise<void> {
  activeWorktreeRoots.delete(norm(wt.worktreePath));
  try {
    await exec(["worktree", "remove", "--force", wt.worktreePath], workspacePath);
  } catch (e) {
    logger.debug("worktree remove failed (continuing):", e);
  }
  // Belt-and-suspenders: drop any leftover dir + prune the worktree registry.
  await rm(wt.worktreePath, { recursive: true, force: true }).catch(() => {});
  await exec(["worktree", "prune"], workspacePath).catch(() => {});
}
