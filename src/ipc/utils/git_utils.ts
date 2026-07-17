import {
  ATLARIX_CO_AUTHOR_TRAILER,
  getGitAuthor,
} from "./git_author";

export { ATLARIX_CO_AUTHOR_TRAILER } from "./git_author";
import { exec, isGitAvailable, isGitMissingResult } from "./system_git_exec";
import fs from "node:fs";
import pathModule from "node:path";
import { readSettings } from "../../main/settings";
import log from "electron-log";
import type {
  GitBaseParams,
  GitFileParams,
  GitCheckoutParams,
  GitBranchRenameParams,
  GitCloneParams,
  GitCommitParams,
  GitLogParams,
  GitFileAtCommitParams,
  GitSetRemoteUrlParams,
  GitStageToRevertParams,
  GitInitParams,
  GitPushParams,
  GitCommit,
} from "../git_types";

const logger = log.scope("git_utils");

/**
 * All local git operations shell out to the system (or bundled) git —
 * isomorphic-git cannot read packfiles ≥2GiB (it buffers the whole pack) and
 * is kept only as a lazily-imported fallback for the network flows
 * (clone/push/set-remote) when no git binary exists at all.
 */

let warnedGitMissing = false;
function warnGitMissingOnce(op: string): void {
  if (warnedGitMissing) return;
  warnedGitMissing = true;
  logger.warn(
    `No git binary available (first noticed during '${op}'); git-backed features are disabled until Git is installed.`,
  );
}

/** Walk parents for a `.git` directory (workspace may be a subfolder of the repo). */
export function findGitRepositoryRoot(workspacePath: string): string | null {
  let dir = pathModule.resolve(workspacePath);
  const root = pathModule.parse(dir).root;
  while (true) {
    try {
      if (fs.existsSync(pathModule.join(dir, ".git"))) return dir;
    } catch {
      /* ignore */
    }
    const parent = pathModule.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  return null;
}

export async function hasGitRepository(workspacePath: string): Promise<boolean> {
  return findGitRepositoryRoot(workspacePath) != null;
}

function resolveGitDir(workspacePath: string): string | null {
  return findGitRepositoryRoot(workspacePath);
}

/**
 * Helper function that wraps exec and throws an error if the exit code is non-zero
 */
async function execOrThrow(
  args: string[],
  path: string,
  errorMessage?: string,
): Promise<void> {
  const result = await exec(args, path);
  if (result.exitCode !== 0) {
    const errorDetails = result.stderr.trim() || result.stdout.trim();
    const error = errorMessage
      ? `${errorMessage}. ${errorDetails}`
      : `Git command failed: ${args.join(" ")}. ${errorDetails}`;
    throw new Error(error);
  }
}

/**
 * True when the repo has a resolvable `user.email` (from local or global git
 * config). Used to decide whether Atlarix should fall back to the agent identity
 * as author: configured machines keep the user as author (Atlarix is credited via
 * the co-author trailer only); an unconfigured machine gets the agent identity so
 * the commit still succeeds instead of failing with "tell me who you are".
 */
export async function hasConfiguredGitIdentity(
  workspacePath: string,
): Promise<boolean> {
  const gitDir = resolveGitDir(workspacePath);
  if (!gitDir) return false;
  const result = await exec(["config", "--get", "user.email"], gitDir);
  if (isGitMissingResult(result)) return false;
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

export async function getCurrentCommitHash({
  path,
  ref = "HEAD",
}: GitInitParams): Promise<string> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return "";
  const result = await exec(["rev-parse", ref], gitDir);
  if (isGitMissingResult(result)) {
    warnGitMissingOnce("rev-parse");
    return "";
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to resolve ref '${ref}': ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

export async function isGitStatusClean({
  path,
}: {
  path: string;
}): Promise<boolean> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return true;
  const result = await exec(["status", "--porcelain"], gitDir);
  if (isGitMissingResult(result)) {
    warnGitMissingOnce("status");
    return true;
  }
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get status: ${result.stderr}`);
  }

  // If output is empty, working directory is clean (no changes)
  const isClean = result.stdout.trim().length === 0;
  return isClean;
}

/** Returns the co-author trailer when user has not disabled it in settings (fresh read every call). */
export function getCoAuthorTrailerForCommit(): string | undefined {
  const settings = readSettings();
  return settings.includeAtlarixCoAuthor !== false ? ATLARIX_CO_AUTHOR_TRAILER : undefined;
}

export async function gitCommit({
  path,
  message,
  amend,
  allowEmpty,
}: GitCommitParams): Promise<string> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return "";
  const coAuthorTrailer = getCoAuthorTrailerForCommit();
  const finalMessage =
    coAuthorTrailer && !message.trimEnd().endsWith(coAuthorTrailer)
      ? `${message}\n\n${coAuthorTrailer}`
      : message;

  // Author = the user's own git config (Atlarix is credited via the co-author
  // trailer only). Fall back to the agent identity as author ONLY when the
  // machine has no configured git identity, so the commit still succeeds.
  const args = ["commit", "-m", finalMessage];
  if (!(await hasConfiguredGitIdentity(gitDir))) {
    const author = await getGitAuthor();
    args.push("--author", `${author.name} <${author.email}>`);
  }
  if (amend) {
    args.push("--amend");
  }
  if (allowEmpty) {
    args.push("--allow-empty");
  }
  await execOrThrow(args, gitDir, "Failed to create commit");
  // Get the new commit hash
  const result = await exec(["rev-parse", "HEAD"], gitDir);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to get commit hash: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

export async function gitCheckout({
  path,
  ref,
}: GitCheckoutParams): Promise<void> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return;
  await execOrThrow(
    ["checkout", ref],
    gitDir,
    `Failed to checkout ref '${ref}'`,
  );
}

export async function gitStageToRevert({
  path,
  targetOid,
}: GitStageToRevertParams): Promise<void> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return;
  // Get the current HEAD commit hash
  const currentHeadResult = await exec(["rev-parse", "HEAD"], gitDir);
  if (currentHeadResult.exitCode !== 0) {
    throw new Error(
      `Failed to get current commit: ${currentHeadResult.stderr.trim() || currentHeadResult.stdout.trim()}`,
    );
  }

  const currentCommit = currentHeadResult.stdout.trim();

  // If we're already at the target commit, nothing to do
  if (currentCommit === targetOid) {
    return;
  }

  // Safety: refuse to run if the work-tree isn't clean.
  const statusResult = await exec(["status", "--porcelain"], gitDir);
  if (statusResult.exitCode !== 0) {
    throw new Error(
      `Failed to get status: ${statusResult.stderr.trim() || statusResult.stdout.trim()}`,
    );
  }
  if (statusResult.stdout.trim() !== "") {
    throw new Error("Cannot revert: working tree has uncommitted changes.");
  }

  // Reset the working directory and index to match the target commit state
  // This effectively undoes all changes since the target commit
  await execOrThrow(
    ["reset", "--hard", targetOid],
    gitDir,
    `Failed to reset to target commit '${targetOid}'`,
  );

  // Reset back to the original HEAD but keep the working directory as it is
  // This stages all the changes needed to revert to the target state
  await execOrThrow(
    ["reset", "--soft", currentCommit],
    gitDir,
    "Failed to reset back to original HEAD",
  );
}

export async function gitAddAll({ path }: GitBaseParams): Promise<void> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return;
  await execOrThrow(["add", "."], gitDir, "Failed to stage all files");
}

export async function gitAdd({ path, filepath }: GitFileParams): Promise<void> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return;
  await execOrThrow(
    ["add", "--", filepath],
    gitDir,
    `Failed to stage file '${filepath}'`,
  );
}

export async function gitRemove({
  path,
  filepath,
}: GitFileParams): Promise<void> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return;
  await execOrThrow(
    ["rm", "-f", "--", filepath],
    gitDir,
    `Failed to remove file '${filepath}'`,
  );
}

export async function getGitUncommittedFiles({
  path,
}: GitBaseParams): Promise<string[]> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return [];
  const result = await exec(["status", "--porcelain"], gitDir);
  if (isGitMissingResult(result)) {
    warnGitMissingOnce("status");
    return [];
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to get uncommitted files: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim());
}

export async function getFileAtCommit({
  path,
  filePath,
  commitHash,
}: GitFileAtCommitParams): Promise<string | null> {
  try {
    const result = await exec(["show", `${commitHash}:${filePath}`], path);
    if (result.exitCode !== 0) {
      // File doesn't exist at this commit, git missing, or other error
      return null;
    }
    return result.stdout;
  } catch (error: any) {
    logger.error(
      `Error getting file at commit ${commitHash}: ${error.message}`,
    );
    // File doesn't exist at this commit
    return null;
  }
}

export async function gitListBranches({
  path,
}: GitBaseParams): Promise<string[]> {
  const result = await exec(["branch", "--list"], path);
  if (isGitMissingResult(result)) {
    warnGitMissingOnce("branch --list");
    return [];
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  // Parse output:
  // e.g. "* main\n  feature/login"
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.replace("*", "").trim())
    .filter((line) => line.length > 0);
}

export async function gitRenameBranch({
  path,
  oldBranch,
  newBranch,
}: GitBranchRenameParams): Promise<void> {
  // git branch -m oldBranch newBranch
  const result = await exec(["branch", "-m", oldBranch, newBranch], path);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

export async function gitClone({
  path,
  url,
  accessToken,
  singleBranch = true,
  depth,
  signal,
}: GitCloneParams): Promise<void> {
  if (signal?.aborted) {
    const err = new Error("Clone cancelled");
    err.name = "AbortError";
    throw err;
  }
  if (await isGitAvailable()) {
    // Build authenticated URL if accessToken is provided and URL doesn't already have auth
    const finalUrl =
      accessToken && !url.includes("@")
        ? url.replace("https://", `https://${accessToken}:x-oauth-basic@`)
        : url;
    const args = ["clone"];
    if (depth && depth > 0) {
      args.push("--depth", String(depth));
    }
    if (singleBranch) {
      args.push("--single-branch");
    }
    args.push(finalUrl, path);
    const result = await exec(args, ".", { signal });

    if (signal?.aborted) {
      const err = new Error("Clone cancelled");
      err.name = "AbortError";
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }
  } else {
    logger.warn("gitClone: no git binary — using isomorphic-git fallback");
    const { default: git } = await import("isomorphic-git");
    const { default: http } = await import("isomorphic-git/http/node");
    // Strip any embedded auth from URL since isomorphic-git uses onAuth
    const cleanUrl = url.replace(/https:\/\/[^@]+@/, "https://");
    await git.clone({
      fs,
      http,
      dir: path,
      url: cleanUrl,
      onAuth: accessToken
        ? () => ({
            username: accessToken,
            password: "x-oauth-basic",
          })
        : undefined,
      singleBranch,
      depth: depth ?? undefined,
    });
    if (signal?.aborted) {
      const err = new Error("Clone cancelled");
      err.name = "AbortError";
      throw err;
    }
  }
}

export async function gitSetRemoteUrl({
  path,
  remoteUrl,
}: GitSetRemoteUrlParams): Promise<void> {
  if (await isGitAvailable()) {
    try {
      // Try to add the remote
      const result = await exec(["remote", "add", "origin", remoteUrl], path);

      // If remote already exists, update it instead
      if (result.exitCode !== 0 && result.stderr.includes("already exists")) {
        const updateResult = await exec(
          ["remote", "set-url", "origin", remoteUrl],
          path,
        );

        if (updateResult.exitCode !== 0) {
          throw new Error(`Failed to update remote: ${updateResult.stderr}`);
        }
      } else if (result.exitCode !== 0) {
        // Handle other errors
        throw new Error(`Failed to add remote: ${result.stderr}`);
      }
    } catch (error: any) {
      logger.error("Error setting up remote:", error);
      throw error; // or handle as needed
    }
  } else {
    logger.warn("gitSetRemoteUrl: no git binary — using isomorphic-git fallback");
    const { default: git } = await import("isomorphic-git");
    await git.setConfig({
      fs,
      dir: path,
      path: "remote.origin.url",
      value: remoteUrl,
    });
  }
}

export async function gitPush({
  path,
  branch,
  accessToken,
  force,
}: GitPushParams): Promise<void> {
  if (await isGitAvailable()) {
    try {
      // Push using the configured origin remote (which already has auth in URL)
      const args = ["push", "origin", `main:${branch}`];
      if (force) {
        args.push("--force");
      }
      const result = await exec(args, path);

      if (result.exitCode !== 0) {
        const errorMsg = result.stderr.toString() || result.stdout.toString();
        throw new Error(`Git push failed: ${errorMsg}`);
      }
    } catch (error: any) {
      logger.error("Error during git push:", error);
      throw new Error(`Git push failed: ${error.message}`);
    }
  } else {
    logger.warn("gitPush: no git binary — using isomorphic-git fallback");
    const { default: git } = await import("isomorphic-git");
    const { default: http } = await import("isomorphic-git/http/node");
    await git.push({
      fs,
      http,
      dir: path,
      remote: "origin",
      ref: "main",
      remoteRef: branch,
      onAuth: () => ({
        username: accessToken,
        password: "x-oauth-basic",
      }),
      force: !!force,
    });
  }
}

export async function gitCurrentBranch({
  path,
}: GitBaseParams): Promise<string | null> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return null;
  const result = await exec(["branch", "--show-current"], gitDir);
  if (isGitMissingResult(result)) {
    warnGitMissingOnce("branch --show-current");
    return null;
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to get current branch: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const branch = result.stdout.trim() || null;
  return branch;
}

export async function gitLog({
  path,
  depth = 100_000,
}: GitLogParams): Promise<GitCommit[]> {
  const gitDir = resolveGitDir(path);
  if (!gitDir) return [];
  return await gitLogNative(gitDir, depth);
}

export async function gitIsIgnored({
  path,
  filepath,
}: GitFileParams): Promise<boolean> {
  // git check-ignore file
  const result = await exec(["check-ignore", filepath], path);

  // If exitCode == 0 → file is ignored
  if (result.exitCode === 0) return true;

  // If exitCode == 1 → not ignored
  if (result.exitCode === 1) return false;

  if (isGitMissingResult(result)) {
    warnGitMissingOnce("check-ignore");
    return false;
  }

  // Other exit codes are actual errors
  throw new Error(result.stderr.toString());
}

export async function gitLogNative(
  path: string,
  depth = 100_000,
): Promise<GitCommit[]> {
  // Use git log with custom format to get all data in a single process
  // Format: %H = commit hash, %at = author timestamp (unix), %B = raw body (message)
  // Using null byte as field separator and custom delimiter between commits
  const logArgs = [
    "log",
    "--max-count",
    String(depth),
    "--format=%H%x00%at%x00%B%x00---END-COMMIT---",
    "HEAD",
  ];

  const logResult = await exec(logArgs, path);

  if (isGitMissingResult(logResult)) {
    warnGitMissingOnce("log");
    return [];
  }
  if (logResult.exitCode !== 0) {
    throw new Error(logResult.stderr.toString());
  }

  const output = logResult.stdout.toString().trim();
  if (!output) {
    return [];
  }

  // Split by commit delimiter (without newline since trim() removes trailing newline)
  const commitChunks = output.split("\x00---END-COMMIT---").filter(Boolean);
  const entries: GitCommit[] = [];

  for (const chunk of commitChunks) {
    // Split by null byte: [oid, timestamp, message]
    const parts = chunk.split("\x00");
    if (parts.length >= 3) {
      const oid = parts[0].trim();
      const timestamp = Number(parts[1]);
      // Message is everything after the second null byte, may contain null bytes itself
      const message = parts.slice(2).join("\x00");

      entries.push({
        oid,
        commit: {
          message: message,
          author: {
            timestamp: timestamp,
          },
        },
      });
    }
  }

  return entries;
}
