/**
 * Repo identity for workspace file permissions (0g): one repo, one approval.
 *
 * A file approval used to be keyed by the workspace row (appId), so three
 * sessions in three worktrees of the same repo each asked for the same folder.
 * The stable identity of "the same repo" across worktrees is the git COMMON
 * directory — the main checkout's `.git`, which every linked worktree points at
 * (never the folder name). Shared rules are keyed by that path, and their
 * scope values are expressed relative to the repo ROOT (the worktree top-level),
 * which is the same relative path in every worktree.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeRelativePath } from "./file-permission-scope";
import { realAppPath } from "./canonical-app-path";

export interface FileRepoContext {
  /** realpath of the git common dir — shared by every worktree of the repo. */
  repoKey: string;
  /** realpath of the git top-level (this worktree's root). */
  repoRoot: string;
}

const cache = new Map<string, FileRepoContext | null>();

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function computeRepoContext(workspacePath: string): FileRepoContext | null {
  // `--git-common-dir` is `.git` (relative) in the main checkout and the absolute
  // main `.git` in a linked worktree; resolve the relative form against the
  // workspace so both spellings collapse to the same key.
  const commonDir = runGit(
    ["-C", workspacePath, "rev-parse", "--git-common-dir"],
    workspacePath,
  );
  if (!commonDir) return null;
  const topLevel = runGit(
    ["-C", workspacePath, "rev-parse", "--show-toplevel"],
    workspacePath,
  );
  if (!topLevel) return null;
  try {
    const repoKey = fs.realpathSync.native(path.resolve(workspacePath, commonDir));
    const repoRoot = fs.realpathSync.native(topLevel);
    return { repoKey, repoRoot };
  } catch {
    return null;
  }
}

/** The repo identity for a workspace, or null when it is not a git checkout. */
export function resolveFileRepoContext(
  workspacePath: string,
): FileRepoContext | null {
  if (!workspacePath) return null;
  if (cache.has(workspacePath)) return cache.get(workspacePath) ?? null;
  const result = computeRepoContext(workspacePath);
  cache.set(workspacePath, result);
  return result;
}

export function resetFileRepoContextCacheForTests(): void {
  cache.clear();
}

/** A workspace-relative path re-expressed relative to the repo root (posix). */
export function toRepoRelativePath(
  ctx: FileRepoContext,
  workspacePath: string,
  workspaceRelative: string,
): string {
  // Both sides must be in the same (symlink-resolved) space: `repoRoot` is
  // realpath'd, so the absolute file path is too — macOS `/var` vs `/private/var`
  // would otherwise yield a `../../..` answer for a path inside the repo.
  const abs = realAppPath(path.resolve(workspacePath, workspaceRelative));
  const rel = path.relative(ctx.repoRoot, abs);
  return normalizeRelativePath(rel);
}
