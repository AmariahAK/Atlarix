/**
 * Shadow-git snapshots for per-turn code revert (v10).
 * ====================================================
 * Pre-write file state is stored in a hidden git repository per workspace
 * under the app's userData dir — content-addressed (deduped), pruned after
 * SNAPSHOT_RETENTION_DAYS, and never touching the user's own `.git`:
 *
 *   userData/shadow-snapshots/<workspaceKey>/   ← GIT_DIR (bare + core.bare=false)
 *     turns/<seg>.json                          ← per-turn manifest
 *     index-<seg>                               ← per-turn GIT_INDEX_FILE
 *     refs/atlarix/turns/<seg>                  ← commit pinning the turn's tree
 *
 * Capture: stage each touched file's PRE-write bytes into the turn's private
 * index (first capture wins per path), `write-tree` + `commit-tree`, pin via
 * ref. Files that did not exist pre-write are recorded as created — revert
 * deletes them instead of restoring an empty file (fixes a legacy quirk).
 *
 * Revert: `checkout <ref> -- <paths>` against the workspace work-tree.
 *
 * Legacy fallback: turns captured by the old file-copy store
 * (`.atlarix/snapshots/<turnId>/files/*.bak`) still revert via the old path.
 *
 * Snapshot eligibility is enforced by callers (e.g. PermissionInterceptor):
 * `captureSnapshot` only needs `workspacePath` and `turnId`. Ephemeral Ask
 * turns pass no turn id, so nothing is written.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { exec } from "@/ipc/utils/system_git_exec";
import log from "electron-log";
import { sanitizeLedgerDirSegment } from "@/lib/tasks/task-ledger";
import { getUserDataPath } from "@/paths/paths";
import {
  ATLARIX_GIT_AUTHOR_NAME,
  ATLARIX_GIT_AUTHOR_EMAIL,
} from "@/ipc/utils/git_author";

const logger = log.scope("snapshot-manager");

const SHADOW_ROOT_DIR = "shadow-snapshots";
const TURNS_DIR = "turns";
const REF_PREFIX = "refs/atlarix/turns";
const SNAPSHOT_RETENTION_DAYS = 14;
/** Skip files larger than this — snapshots are for source files, not blobs. */
const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024;

export interface SnapshotManifest {
  /** Logical turn id (e.g. `plan:7`, SQLite message id); used for UI and ledger correlation. */
  turnId: string;
  timestamp: string;
  prompt?: string;
  /** Workspace-relative paths touched this turn (capture order). */
  filesChanged: string[];
  /** Subset of filesChanged that did NOT exist pre-write (revert deletes them). */
  createdFiles: string[];
}

function workspaceKey(workspacePath: string): string {
  return createHash("sha256")
    .update(path.resolve(workspacePath))
    .digest("hex")
    .slice(0, 16);
}

let shadowRootOverride: string | null = null;

/** Test seam — point the shadow store at a temp dir. */
export function _setShadowSnapshotsRootForTests(root: string | null): void {
  shadowRootOverride = root;
}

function shadowGitDir(workspacePath: string): string {
  const root = shadowRootOverride ?? path.join(getUserDataPath(), SHADOW_ROOT_DIR);
  return path.join(root, workspaceKey(workspacePath));
}

function turnManifestPath(gitDir: string, seg: string): string {
  return path.join(gitDir, TURNS_DIR, `${seg}.json`);
}

function turnIndexPath(gitDir: string, seg: string): string {
  return path.join(gitDir, `index-${seg}`);
}

function turnRef(seg: string): string {
  return `${REF_PREFIX}/${seg}`;
}

function gitEnv(gitDir: string, workspacePath: string, seg?: string) {
  const env: Record<string, string> = {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workspacePath,
    GIT_AUTHOR_NAME: ATLARIX_GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: ATLARIX_GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: ATLARIX_GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: ATLARIX_GIT_AUTHOR_EMAIL,
  };
  if (seg) env.GIT_INDEX_FILE = turnIndexPath(gitDir, seg);
  return env;
}

async function git(
  args: string[],
  workspacePath: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await exec(args, workspacePath, { env });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function ensureShadowRepo(workspacePath: string): Promise<string> {
  const gitDir = shadowGitDir(workspacePath);
  try {
    await fs.access(path.join(gitDir, "HEAD"));
    return gitDir;
  } catch {
    // not initialized yet
  }
  await fs.mkdir(gitDir, { recursive: true });
  const init = await git(["init", "--bare", "--quiet", gitDir], workspacePath, {});
  if (init.exitCode !== 0) {
    throw new Error(`shadow git init failed: ${init.stderr || init.stdout}`);
  }
  // Allow work-tree operations against the bare dir (dotfiles pattern).
  await git(
    ["--git-dir", gitDir, "config", "core.bare", "false"],
    workspacePath,
    {},
  );
  await fs.mkdir(path.join(gitDir, TURNS_DIR), { recursive: true });
  logger.info(`Initialized shadow snapshot repo for ${workspacePath}`);
  return gitDir;
}

async function readManifest(
  gitDir: string,
  seg: string,
): Promise<SnapshotManifest | null> {
  try {
    const raw = await fs.readFile(turnManifestPath(gitDir, seg), "utf8");
    return JSON.parse(raw) as SnapshotManifest;
  } catch {
    return null;
  }
}

/** Serialize snapshot mutations per workspace (captures within a turn are ordered). */
const captureChains = new Map<string, Promise<unknown>>();

function withWorkspaceLock<T>(
  workspacePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = workspaceKey(workspacePath);
  const prev = captureChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  captureChains.set(key, next.catch(() => undefined));
  return next;
}

export interface CaptureSnapshotParams {
  workspacePath: string;
  turnId: string;
  relativePaths: string[];
  promptSummary?: string;
}

/**
 * Before approved writes: stage current file bytes into the turn's shadow tree
 * and update the manifest. First capture per path wins (pre-write state).
 */
export async function captureSnapshot(params: CaptureSnapshotParams): Promise<void> {
  const { workspacePath, turnId } = params;
  if (!workspacePath || !turnId) return;

  await withWorkspaceLock(workspacePath, async () => {
    try {
      const gitDir = await ensureShadowRepo(workspacePath);
      const seg = sanitizeLedgerDirSegment(turnId);
      const env = gitEnv(gitDir, workspacePath, seg);

      const manifest: SnapshotManifest = (await readManifest(gitDir, seg)) ?? {
        turnId,
        timestamp: new Date().toISOString(),
        prompt: params.promptSummary,
        filesChanged: [],
        createdFiles: [],
      };
      if (params.promptSummary) manifest.prompt = params.promptSummary;

      const known = new Set(manifest.filesChanged);
      const normalized = params.relativePaths
        .map((p) => p.split(path.sep).join("/"))
        .filter(Boolean);
      const newPaths = normalized.filter((rel) => !known.has(rel));
      if (newPaths.length === 0) return;

      // Seed the per-turn index from the turn's previous tree (if any).
      const hasRef =
        (await git(["rev-parse", "--verify", "--quiet", turnRef(seg)], workspacePath, env))
          .exitCode === 0;
      await git(
        hasRef ? ["read-tree", turnRef(seg)] : ["read-tree", "--empty"],
        workspacePath,
        env,
      );

      const toStage: string[] = [];
      for (const rel of newPaths) {
        manifest.filesChanged.push(rel);
        try {
          const st = await fs.stat(path.join(workspacePath, rel));
          if (!st.isFile()) {
            manifest.createdFiles.push(rel);
            continue;
          }
          if (st.size > MAX_SNAPSHOT_FILE_BYTES) {
            logger.warn(`Skipping snapshot of large file (${st.size}B): ${rel}`);
            continue;
          }
          toStage.push(rel);
        } catch {
          // File doesn't exist yet — the write creates it; revert deletes it.
          manifest.createdFiles.push(rel);
        }
      }

      if (toStage.length > 0) {
        const add = await git(["add", "-f", "--", ...toStage], workspacePath, env);
        if (add.exitCode !== 0) {
          logger.warn(`shadow add failed: ${add.stderr || add.stdout}`);
        }
      }

      const tree = await git(["write-tree"], workspacePath, env);
      if (tree.exitCode !== 0) {
        throw new Error(`write-tree failed: ${tree.stderr}`);
      }
      const commit = await git(
        ["commit-tree", tree.stdout.trim(), "-m", `atlarix snapshot ${turnId}`],
        workspacePath,
        env,
      );
      if (commit.exitCode !== 0) {
        throw new Error(`commit-tree failed: ${commit.stderr}`);
      }
      await git(
        ["update-ref", turnRef(seg), commit.stdout.trim()],
        workspacePath,
        env,
      );

      manifest.timestamp = new Date().toISOString();
      await fs.mkdir(path.join(gitDir, TURNS_DIR), { recursive: true });
      await fs.writeFile(
        turnManifestPath(gitDir, seg),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );

      void maybePruneOldSnapshots(workspacePath, gitDir);
    } catch (err) {
      // Never block the write pipeline on snapshot failures.
      logger.warn(`captureSnapshot failed for turn ${turnId}:`, err);
    }
  });
}

export interface RevertSnapshotResult {
  success: boolean;
  error?: string;
  restoredFiles?: number;
}

async function listTreePaths(
  gitDir: string,
  workspacePath: string,
  seg: string,
): Promise<Set<string>> {
  const env = gitEnv(gitDir, workspacePath, seg);
  const out = await git(
    ["ls-tree", "-r", "--name-only", turnRef(seg)],
    workspacePath,
    env,
  );
  if (out.exitCode !== 0) return new Set();
  return new Set(out.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
}

async function shadowRevert(
  workspacePath: string,
  turnId: string,
  filterPaths: string[] | null,
): Promise<RevertSnapshotResult | null> {
  const gitDir = shadowGitDir(workspacePath);
  const seg = sanitizeLedgerDirSegment(turnId);
  const manifest = await readManifest(gitDir, seg);
  if (!manifest) return null; // not a shadow-git turn — caller falls back to legacy

  const env = gitEnv(gitDir, workspacePath, seg);
  const inTree = await listTreePaths(gitDir, workspacePath, seg);
  const created = new Set(manifest.createdFiles ?? []);

  const wanted =
    filterPaths == null
      ? manifest.filesChanged
      : filterPaths
          .map((p) => p.split(path.sep).join("/"))
          .filter((rel) => manifest.filesChanged.includes(rel));

  let restored = 0;
  const toCheckout = wanted.filter((rel) => inTree.has(rel));
  if (toCheckout.length > 0) {
    const co = await git(
      ["checkout", turnRef(seg), "--", ...toCheckout],
      workspacePath,
      env,
    );
    if (co.exitCode === 0) {
      restored += toCheckout.length;
    } else {
      logger.warn(`shadow checkout failed: ${co.stderr || co.stdout}`);
      // Fall back to per-file restore so one bad path doesn't sink the batch.
      for (const rel of toCheckout) {
        const single = await git(
          ["checkout", turnRef(seg), "--", rel],
          workspacePath,
          env,
        );
        if (single.exitCode === 0) restored++;
      }
    }
  }

  // Files created during the turn: revert removes them.
  for (const rel of wanted) {
    if (inTree.has(rel) || !created.has(rel)) continue;
    try {
      await fs.rm(path.join(workspacePath, rel), { force: true });
      restored++;
    } catch {
      // ignore
    }
  }

  return { success: true, restoredFiles: restored };
}

// v10.1: legacy pre-v10 `.bak` file-copy revert fallback removed — turns
// captured before the shadow-git store can no longer be reverted.

/** Restore all files captured for a turn. */
export async function revertSnapshot(params: {
  workspacePath: string;
  turnId: string;
}): Promise<RevertSnapshotResult> {
  const { workspacePath, turnId } = params;
  return withWorkspaceLock(workspacePath, async () => {
    const shadow = await shadowRevert(workspacePath, turnId, null);
    if (shadow) return shadow;
    return { success: false, restoredFiles: 0 };
  });
}

/** Restore only specific workspace-relative paths captured for a turn. */
export async function revertSnapshotFiles(params: {
  workspacePath: string;
  turnId: string;
  relativePaths: string[];
}): Promise<RevertSnapshotResult> {
  const { workspacePath, turnId, relativePaths } = params;
  if (relativePaths.length === 0) {
    return { success: true, restoredFiles: 0 };
  }
  return withWorkspaceLock(workspacePath, async () => {
    const shadow = await shadowRevert(workspacePath, turnId, relativePaths);
    if (shadow) return shadow;
    return { success: false, restoredFiles: 0 };
  });
}

/** True when a snapshot exists for this turn (shadow-git store). */
export async function snapshotExists(
  workspacePath: string,
  turnId: string,
): Promise<boolean> {
  if (!workspacePath || !turnId) return false;
  const seg = sanitizeLedgerDirSegment(turnId);
  const manifest = await readManifest(shadowGitDir(workspacePath), seg);
  return manifest != null;
}

/**
 * v13.1: the workspace-relative files a turn changed (+ which were newly
 * created). Used by the "revert this turn's file changes" affordance to show
 * what a revert will restore/delete. Null when the turn captured no snapshot.
 */
export async function listSnapshotFiles(
  workspacePath: string,
  turnId: string,
): Promise<{ filesChanged: string[]; createdFiles: string[] } | null> {
  if (!workspacePath || !turnId) return null;
  const seg = sanitizeLedgerDirSegment(turnId);
  const manifest = await readManifest(shadowGitDir(workspacePath), seg);
  if (!manifest) return null;
  return {
    filesChanged: manifest.filesChanged ?? [],
    createdFiles: manifest.createdFiles ?? [],
  };
}

// ── Retention ───────────────────────────────────────────────────────────────

const prunedThisSession = new Set<string>();

/** Drop turn refs + manifests older than the retention window, then gc. */
async function maybePruneOldSnapshots(
  workspacePath: string,
  gitDir: string,
): Promise<void> {
  const key = workspaceKey(workspacePath);
  if (prunedThisSession.has(key)) return;
  prunedThisSession.add(key);
  try {
    const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const turnsDir = path.join(gitDir, TURNS_DIR);
    const names = await fs.readdir(turnsDir).catch(() => [] as string[]);
    let dropped = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const seg = name.slice(0, -".json".length);
      const manifest = await readManifest(gitDir, seg);
      const ts = manifest ? Date.parse(manifest.timestamp) : NaN;
      if (Number.isNaN(ts) || ts >= cutoff) continue;
      await git(["update-ref", "-d", turnRef(seg)], workspacePath, {
        GIT_DIR: gitDir,
      });
      await fs.rm(path.join(turnsDir, name), { force: true });
      await fs.rm(turnIndexPath(gitDir, seg), { force: true });
      dropped++;
    }
    if (dropped > 0) {
      await git(
        ["gc", "--quiet", "--prune=now"],
        workspacePath,
        { GIT_DIR: gitDir },
      );
      logger.info(`Pruned ${dropped} expired snapshot turn(s) for ${workspacePath}`);
    }
  } catch (err) {
    logger.warn("snapshot prune failed:", err);
  }
}
