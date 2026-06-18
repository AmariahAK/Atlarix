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
 * and the caller falls back to a read-only scout. Worktrees start from HEAD, so
 * a writer does not see the user's *uncommitted* edits — a deliberate, simple
 * isolation boundary.
 */

import path from "node:path";
import { rm, readdir } from "node:fs/promises";
import log from "electron-log";
import { exec } from "@/ipc/utils/system_git_exec";
import { getUserDataPath } from "@/paths/paths";

const logger = log.scope("subagent-worktree");

/** Absolute, normalized roots of worktrees currently in use. */
const activeWorktreeRoots = new Set<string>();

export interface SubagentWorktree {
  worktreePath: string;
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
 * Create an isolated worktree for a writing sub-agent, or null when the
 * workspace is not a git repo (caller falls back to a read-only scout).
 */
export async function createSubagentWorktree(
  workspacePath: string,
  taskId: string,
): Promise<SubagentWorktree | null> {
  if (!(await isGitRepo(workspacePath))) {
    logger.info("Workspace is not a git repo — writer sub-agent unavailable");
    return null;
  }

  // Reap any worktrees a previously-crashed writer left behind before adding one.
  await cleanupStaleSubagentWorktrees(workspacePath);

  const head = await exec(["rev-parse", "HEAD"], workspacePath);
  if (head.exitCode !== 0) {
    logger.warn("Could not resolve HEAD — writer sub-agent unavailable:", head.stderr.trim());
    return null;
  }
  const baseRef = head.stdout.trim();

  // Unique, sanitized worktree path under userData (never inside the workspace).
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, "");
  const worktreePath = path.join(worktreeDirForWorkspace(workspacePath), safeId);

  const add = await exec(
    ["worktree", "add", "--detach", worktreePath, baseRef],
    workspacePath,
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

/** Stage everything in the worktree and diff it against the base commit. */
export async function captureWorktreeDiff(
  wt: SubagentWorktree,
): Promise<WorktreeDiff> {
  await exec(["add", "-A"], wt.worktreePath);
  const [names, diff] = await Promise.all([
    exec(["diff", "--cached", "--name-only", wt.baseRef], wt.worktreePath),
    exec(["diff", "--cached", wt.baseRef], wt.worktreePath),
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
