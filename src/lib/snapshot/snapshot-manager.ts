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
import * as fsSync from "fs";
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
  /**
   * When the user put this turn's files back (the app's Revert on a reply).
   * The reply then shows it, after a restart too, instead of offering Revert
   * again.
   */
  revertedAt?: string;
  /** When the agent was told about that revert (once, with the next message). */
  revertToldAt?: string;
  /**
   * Each changed file as the turn LEFT it (git blob id, or size:mtime past the
   * snapshot limit; null when absent), recorded
   * at the turn's end. A revert keeps a file that differs now: the user, a
   * later turn or a teammate session changed it since (owner: no random
   * reverts). Missing for a turn from before this or one that never reached
   * its end; such a revert cannot check.
   */
  endHashes?: Record<string, string | null>;
  /** The files the last revert actually put back (kept ones excluded). */
  revertedFiles?: string[];
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
  byteExactRepos.clear(); // as a fresh run would see them
}

function shadowGitDir(workspacePath: string): string {
  const root =
    shadowRootOverride ?? path.join(getUserDataPath(), SHADOW_ROOT_DIR);
  return path.join(root, workspaceKey(workspacePath));
}

function turnManifestPath(gitDir: string, seg: string): string {
  return path.join(gitDir, TURNS_DIR, `${seg}.json`);
}

/**
 * Extra roots a turn touched outside the primary workspace, owned by the PRIMARY
 * workspace's shadow repo.
 *
 * A turn that edits this project and a granted sibling produces one shadow repo per root
 * (each keyed by its own path, each with its own work-tree), so revert needs one place to
 * ask "what did this turn touch?" — that place is here.
 */
function turnRootsPath(gitDir: string, seg: string): string {
  return path.join(gitDir, TURNS_DIR, `${seg}.roots.json`);
}

async function readTurnRoots(gitDir: string, seg: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(turnRootsPath(gitDir, seg), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((r) => typeof r === "string")
      : [];
  } catch {
    return [];
  }
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

/**
 * The snapshot must hold, and put back, a file's exact bytes. The shadow git
 * works on the user's own folder, so that folder's .gitattributes (eol=crlf,
 * text=auto, an LFS filter, ident, working-tree-encoding) and a system
 * core.autocrlf (Windows) converted bytes on add and checkout: a restore could
 * change line endings, and a chain then read the rewritten file as "changed
 * since". $GIT_DIR/info/attributes outranks the folder's .gitattributes.
 * Idempotent; done once per repo per run, for repos made before this too.
 */
const BYTE_EXACT_ATTRIBUTES = "* -text -filter -ident -working-tree-encoding\n";
const byteExactRepos = new Set<string>();

async function ensureByteExact(gitDir: string, workspacePath: string): Promise<void> {
  if (byteExactRepos.has(gitDir)) return;
  const attrs = path.join(gitDir, "info", "attributes");
  const current = await fs.readFile(attrs, "utf8").catch(() => null);
  if (current !== BYTE_EXACT_ATTRIBUTES) {
    await fs.mkdir(path.dirname(attrs), { recursive: true });
    await fs.writeFile(attrs, BYTE_EXACT_ATTRIBUTES, "utf8");
  }
  for (const [key, value] of [
    ["core.autocrlf", "false"],
    ["core.eol", "lf"],
  ]) {
    await git(["--git-dir", gitDir, "config", key, value], workspacePath, {});
  }
  byteExactRepos.add(gitDir);
}

async function ensureShadowRepo(workspacePath: string): Promise<string> {
  const gitDir = shadowGitDir(workspacePath);
  try {
    await fs.access(path.join(gitDir, "HEAD"));
    await ensureByteExact(gitDir, workspacePath);
    return gitDir;
  } catch {
    // not initialized yet
  }
  await fs.mkdir(gitDir, { recursive: true });
  const init = await git(
    ["init", "--bare", "--quiet", gitDir],
    workspacePath,
    {},
  );
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
  await ensureByteExact(gitDir, workspacePath);
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

/** What each turn captured this process (root → its files); read at the turn's end. */
const turnFilesThisRun = new Map<string, Map<string, Set<string>>>();

/**
 * Past this a file's end state is its size and mtime, not a hash of its bytes
 * (the end state is read on the main thread at every turn's end). The limit
 * is the snapshot's own: a file a revert can put back is always hashed, since
 * putting back a newer turn rewrites it (new mtime) with exactly how an older
 * turn left it, and only the bytes can tell. A larger file is never restored.
 * Both readers below decide the same way, so they compare like with like.
 */
const HASH_MAX_BYTES = MAX_SNAPSHOT_FILE_BYTES;

/**
 * A file's end state: its git blob id (what `git hash-object` gives), so it
 * compares directly with a snapshot tree's entries, which is how a revert is
 * previewed without writing anything (previewRevert).
 */
function stamp(st: { size: number; mtimeMs: number }, bytes: () => Buffer): string {
  if (st.size > HASH_MAX_BYTES) return `${st.size}:${st.mtimeMs}`;
  const b = bytes();
  return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
}

/** Synchronous on purpose: the end state is read at the instant the turn ends. */
function fileHashSync(abs: string): string | null {
  try {
    const st = fsSync.statSync(abs);
    if (!st.isFile()) return null;
    return stamp(st, () => fsSync.readFileSync(abs));
  } catch {
    return null;
  }
}

async function fileHash(abs: string): Promise<string | null> {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    const bytes = st.size > HASH_MAX_BYTES ? Buffer.alloc(0) : await fs.readFile(abs);
    return stamp(st, () => bytes);
  } catch {
    return null;
  }
}

/** A turn that never ends (a crash mid-turn) must not hold its entry forever. */
const TURN_FILES_MAX = 200;

/** Serialize snapshot mutations per workspace (captures within a turn are ordered). */
const captureChains = new Map<string, Promise<unknown>>();

function withWorkspaceLock<T>(
  workspacePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = workspaceKey(workspacePath);
  const prev = captureChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  captureChains.set(
    key,
    next.catch(() => undefined),
  );
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
export async function captureSnapshot(
  params: CaptureSnapshotParams,
): Promise<void> {
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
        (
          await git(
            ["rev-parse", "--verify", "--quiet", turnRef(seg)],
            workspacePath,
            env,
          )
        ).exitCode === 0;
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
            logger.warn(
              `Skipping snapshot of large file (${st.size}B): ${rel}`,
            );
            continue;
          }
          toStage.push(rel);
        } catch {
          // File doesn't exist yet — the write creates it; revert deletes it.
          manifest.createdFiles.push(rel);
        }
      }

      if (toStage.length > 0) {
        const add = await git(
          ["add", "-f", "--", ...toStage],
          workspacePath,
          env,
        );
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

      const byRoot = turnFilesThisRun.get(turnId) ?? new Map<string, Set<string>>();
      const files = byRoot.get(workspacePath) ?? new Set<string>();
      for (const rel of newPaths) files.add(rel);
      byRoot.set(workspacePath, files);
      turnFilesThisRun.set(turnId, byRoot);
      if (turnFilesThisRun.size > TURN_FILES_MAX) {
        const oldest = turnFilesThisRun.keys().next().value;
        if (oldest !== undefined) turnFilesThisRun.delete(oldest);
      }

      void maybePruneOldSnapshots(workspacePath, gitDir);
    } catch (err) {
      // Never block the write pipeline on snapshot failures.
      logger.warn(`captureSnapshot failed for turn ${turnId}:`, err);
    }
  });
}

/**
 * Capture a turn's pre-write state across the primary workspace AND any granted roots it
 * touched — the whole of cross-project revert.
 *
 * Each root gets its own shadow repo (keyed by its own path, work-tree pointed at it), so
 * `captureSnapshot` runs unchanged per root; only the bookkeeping is new. The primary
 * workspace's shadow repo records which extra roots participated, so revert has one place
 * to ask what the turn touched.
 *
 * This replaced the previous behaviour of DROPPING every outside path
 * (`interceptor.ts`: `.filter((p) => !p.startsWith("../"))`). That filter was right at the
 * time — `git add` with `cwd = workspace` aborts the whole invocation on a path outside
 * its work-tree, so one outside file in a multi-file write destroyed the pre-write
 * snapshot of every in-workspace file beside it. But its consequence was that a cross-repo
 * edit silently had no Revert at all, which is the gap this closes: the path never leaves
 * its own root's work-tree, so git has nothing to object to.
 */
export async function captureSnapshotAcrossRoots(params: {
  /** The primary workspace — owns the roots index. */
  workspacePath: string;
  turnId: string;
  /** Absolute paths, or paths relative to the workspace (`../sibling/x` included). */
  paths: readonly string[];
  /** Roots the user has granted. Nothing outside these is snapshotted. */
  grantedRoots: readonly string[];
  promptSummary?: string;
}): Promise<void> {
  const { workspacePath, turnId } = params;
  if (!workspacePath || !turnId) return;

  const groups = groupPathsByRoot({
    workspacePath,
    paths: params.paths,
    grantedRoots: params.grantedRoots,
  });
  if (groups.length === 0) return;

  for (const group of groups) {
    await captureSnapshot({
      workspacePath: group.root,
      turnId,
      relativePaths: group.relativePaths,
      ...(params.promptSummary ? { promptSummary: params.promptSummary } : {}),
    });
  }

  const extraRoots = groups.filter((g) => !g.isPrimary).map((g) => g.root);
  if (extraRoots.length > 0) {
    await recordTurnRoots(workspacePath, turnId, extraRoots);
  }
}

/**
 * Add roots to a turn's index in the primary workspace's shadow repo.
 *
 * Sequenced AFTER the captures rather than wrapping them: `captureSnapshot` takes the
 * per-root lock itself, so holding the primary's lock around a call that also wants it
 * would deadlock on its own promise chain.
 */
async function recordTurnRoots(
  workspacePath: string,
  turnId: string,
  roots: string[],
): Promise<void> {
  await withWorkspaceLock(workspacePath, async () => {
    try {
      const gitDir = await ensureShadowRepo(workspacePath);
      const seg = sanitizeLedgerDirSegment(turnId);
      const existing = await readTurnRoots(gitDir, seg);
      const merged = [...new Set([...existing, ...roots])];
      if (
        merged.length === existing.length &&
        existing.every((r) => merged.includes(r))
      ) {
        return;
      }
      await fs.mkdir(path.join(gitDir, TURNS_DIR), { recursive: true });
      await fs.writeFile(
        turnRootsPath(gitDir, seg),
        JSON.stringify(merged, null, 2),
        "utf8",
      );
    } catch (err) {
      // Same policy as captureSnapshot: never block a write on snapshot bookkeeping.
      logger.warn(`recordTurnRoots failed for turn ${turnId}:`, err);
    }
  });
}

/** Is `abs` inside `root`? (Both already resolved.) */
function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" ? false : !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Split a turn's touched paths by the root that will snapshot them.
 *
 * In-workspace paths belong to the primary root. A path outside it belongs to the
 * innermost GRANTED root that contains it — innermost so that a grant of `/a/b` inside a
 * grant of `/a` snapshots against the narrower work-tree.
 *
 * A path outside every granted root is DROPPED, not snapshotted. Granting is what makes a
 * folder writable in the first place, so an ungranted outside path cannot have been
 * written by an approved edit — and minting a shadow repo for an arbitrary absolute path
 * would scatter git directories across the user's disk.
 *
 * Exported for testing: the grouping is the whole correctness surface of cross-root
 * revert, and it is pure.
 */
export function groupPathsByRoot(args: {
  workspacePath: string;
  /** Absolute paths, or paths relative to the workspace (`../sibling/x` included). */
  paths: readonly string[];
  grantedRoots: readonly string[];
}): { root: string; relativePaths: string[]; isPrimary: boolean }[] {
  const primary = path.resolve(args.workspacePath);
  // Longest first so the innermost containing grant wins.
  const roots = [
    ...new Set(args.grantedRoots.map((r) => path.resolve(r))),
  ].sort((a, b) => b.length - a.length);
  const byRoot = new Map<string, string[]>();

  for (const raw of args.paths) {
    if (!raw) continue;
    const abs = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(primary, raw);
    const owner = isInside(primary, abs)
      ? primary
      : roots.find((r) => isInside(r, abs));
    if (!owner) continue; // outside every granted root — not ours to snapshot
    const rel = path.relative(owner, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    const list = byRoot.get(owner) ?? [];
    if (!list.includes(rel)) list.push(rel);
    byRoot.set(owner, list);
  }

  return [...byRoot.entries()].map(([root, relativePaths]) => ({
    root,
    relativePaths,
    isPrimary: root === primary,
  }));
}

export interface RevertSnapshotResult {
  success: boolean;
  error?: string;
  restoredFiles?: number;
  /** Files left as they are: changed after the turn (workspace-relative). */
  kept?: string[];
  /** The turn has no record of how it ended, so nothing could be checked. */
  unchecked?: boolean;
}

/**
 * At a turn's end: record each file it changed as it left it, so a later
 * revert can tell what changed since (see `SnapshotManifest.endHashes`).
 * The files are read NOW, synchronously: an edit landing a moment after the
 * turn ended must count as a change since, not as how the turn left it. The
 * manifest is written on each root's lock, so a revert right after waits.
 */
export function recordSnapshotTurnEnd(turnId: string): Promise<void> {
  const byRoot = turnFilesThisRun.get(turnId);
  if (!byRoot) return Promise.resolve();
  turnFilesThisRun.delete(turnId);
  const seg = sanitizeLedgerDirSegment(turnId);
  return Promise.all(
    [...byRoot].map(([root, files]) => {
      const hashes: Record<string, string | null> = {};
      for (const rel of files) hashes[rel] = fileHashSync(path.join(root, rel));
      return withWorkspaceLock(root, async () => {
        const gitDir = shadowGitDir(root);
        const manifest = await readManifest(gitDir, seg);
        if (!manifest) return;
        // Every file the manifest holds needs an end state: one missing (a
        // capture from an earlier run of this turn) leaves the turn uncheckable.
        if (!manifest.filesChanged.every((rel) => rel in hashes)) return;
        manifest.endHashes = hashes;
        await fs.writeFile(
          turnManifestPath(gitDir, seg),
          JSON.stringify(manifest, null, 2),
          "utf8",
        );
      }).catch((err) =>
        logger.warn(`recordSnapshotTurnEnd failed for turn ${turnId}:`, err),
      );
    }),
  ).then(() => undefined);
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
  return new Set(
    out.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function shadowRevert(
  workspacePath: string,
  turnId: string,
  filterPaths: string[] | null,
): Promise<(RevertSnapshotResult & { kept: string[] }) | null> {
  const gitDir = shadowGitDir(workspacePath);
  const seg = sanitizeLedgerDirSegment(turnId);
  const manifest = await readManifest(gitDir, seg);
  if (!manifest) return null; // not a shadow-git turn — caller falls back to legacy
  await ensureByteExact(gitDir, workspacePath);

  const env = gitEnv(gitDir, workspacePath, seg);
  const inTree = await listTreePaths(gitDir, workspacePath, seg);
  const created = new Set(manifest.createdFiles ?? []);

  const asked =
    filterPaths == null
      ? manifest.filesChanged
      : filterPaths
          .map((p) => p.split(path.sep).join("/"))
          .filter((rel) => manifest.filesChanged.includes(rel));

  // A file that is no longer as the turn left it is someone's later work: keep it.
  const ends = manifest.endHashes;
  const kept: string[] = [];
  const wanted: string[] = [];
  for (const rel of asked) {
    if (
      ends &&
      rel in ends &&
      (await fileHash(path.join(workspacePath, rel))) !== ends[rel]
    ) {
      kept.push(rel);
    } else {
      wanted.push(rel);
    }
  }

  let restored = 0;
  const reverted: string[] = [];
  const toCheckout = wanted.filter((rel) => inTree.has(rel));
  if (toCheckout.length > 0) {
    const co = await git(
      ["checkout", turnRef(seg), "--", ...toCheckout],
      workspacePath,
      env,
    );
    if (co.exitCode === 0) {
      restored += toCheckout.length;
      reverted.push(...toCheckout);
    } else {
      logger.warn(`shadow checkout failed: ${co.stderr || co.stdout}`);
      // Fall back to per-file restore so one bad path doesn't sink the batch.
      for (const rel of toCheckout) {
        const single = await git(
          ["checkout", turnRef(seg), "--", rel],
          workspacePath,
          env,
        );
        if (single.exitCode === 0) {
          restored++;
          reverted.push(rel);
        }
      }
    }
  }

  // Files created during the turn: revert removes them.
  for (const rel of wanted) {
    if (inTree.has(rel) || !created.has(rel)) continue;
    try {
      await fs.rm(path.join(workspacePath, rel), { force: true });
      restored++;
      reverted.push(rel);
    } catch {
      // ignore
    }
  }

  manifest.revertedFiles = reverted;
  await fs
    .writeFile(
      turnManifestPath(gitDir, seg),
      JSON.stringify(manifest, null, 2),
      "utf8",
    )
    .catch(() => undefined);

  return {
    success: true,
    restoredFiles: restored,
    kept,
    ...(ends ? {} : { unchecked: true }),
  };
}

/** A root-relative path as the UI shows it (`../sibling/x` for an outside root). */
function displayPath(primary: string, root: string, rel: string): string {
  return root === primary
    ? rel
    : path.relative(primary, path.join(root, rel)).split(path.sep).join("/");
}

/**
 * What reverting these turns (newest first, as the range revert runs) would
 * put back and what it would keep, without writing anything: so a confirm
 * dialog can say "restores 1 file, keeps b.ts" before it happens. Follows
 * each file through the chain: once a newer turn puts it back, it is as that
 * turn's snapshot holds it when the older turn is checked.
 */
export async function previewRevert(
  workspacePath: string,
  turnIdsNewestFirst: string[],
): Promise<{ restores: string[]; kept: string[] }> {
  const primary = path.resolve(workspacePath);
  const state = new Map<string, string | null>();
  const restores = new Set<string>();
  const kept = new Set<string>();
  for (const turnId of turnIdsNewestFirst) {
    const seg = sanitizeLedgerDirSegment(turnId);
    for (const root of await turnRoots(workspacePath, turnId)) {
      const gitDir = shadowGitDir(root);
      const manifest = await readManifest(gitDir, seg);
      if (!manifest) continue;
      const tree = new Map<string, string>();
      // -z: names unquoted, whatever they contain.
      const ls = await git(["ls-tree", "-r", "-z", turnRef(seg)], root, gitEnv(gitDir, root, seg));
      if (ls.exitCode === 0) {
        for (const entry of ls.stdout.split("\0")) {
          const m = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
          if (m) tree.set(m[2]!, m[1]!);
        }
      }
      const created = new Set(manifest.createdFiles ?? []);
      const ends = manifest.endHashes;
      for (const rel of manifest.filesChanged) {
        const key = displayPath(primary, root, rel);
        const now = state.has(key)
          ? state.get(key)!
          : await fileHash(path.join(root, rel));
        if (ends && rel in ends && now !== ends[rel]) {
          kept.add(key);
          state.set(key, now);
          continue;
        }
        restores.add(key);
        state.set(key, tree.get(rel) ?? (created.has(rel) ? null : now));
      }
    }
  }
  // Same rule as the range revert's result (a union over its turns), so the
  // dialog before and the line after always agree.
  return { restores: [...restores], kept: [...kept] };
}

// v10.1: legacy pre-v10 `.bak` file-copy revert fallback removed — turns
// captured before the shadow-git store can no longer be reverted.

/**
 * Every root a turn touched: the primary workspace plus whatever it recorded.
 *
 * The primary is always first, so a revert restores in-workspace files before reaching
 * across into a sibling project.
 */
async function turnRoots(
  workspacePath: string,
  turnId: string,
): Promise<string[]> {
  const primary = path.resolve(workspacePath);
  const extra = await readTurnRoots(
    shadowGitDir(primary),
    sanitizeLedgerDirSegment(turnId),
  );
  return [primary, ...extra.filter((r) => path.resolve(r) !== primary)];
}

/** Restore all files captured for a turn, in every root it touched. */
export async function revertSnapshot(params: {
  workspacePath: string;
  turnId: string;
}): Promise<RevertSnapshotResult> {
  const { workspacePath, turnId } = params;
  const roots = await turnRoots(workspacePath, turnId);
  const primary = path.resolve(workspacePath);
  let restored = 0;
  let anyManifest = false;
  let unchecked = false;
  const kept: string[] = [];

  for (const root of roots) {
    // Per-root lock: each shadow repo has its own capture chain.
    const result = await withWorkspaceLock(root, () =>
      shadowRevert(root, turnId, null),
    );
    if (!result) continue; // no manifest for this root — nothing was captured there
    anyManifest = true;
    restored += result.restoredFiles ?? 0;
    unchecked ||= !!result.unchecked;
    kept.push(...result.kept.map((rel) => displayPath(primary, root, rel)));
  }

  if (!anyManifest) return { success: false, restoredFiles: 0 };
  return {
    success: true,
    restoredFiles: restored,
    kept,
    ...(unchecked ? { unchecked } : {}),
  };
}

/**
 * Restore only specific paths captured for a turn.
 *
 * `paths` arrive as the UI shows them — workspace-relative, which for an outside file
 * means `../sibling/x`. They are grouped back onto their owning root before being handed
 * to that root's shadow repo, where they are root-relative again.
 */
export async function revertSnapshotFiles(params: {
  workspacePath: string;
  turnId: string;
  relativePaths: string[];
}): Promise<RevertSnapshotResult> {
  const { workspacePath, turnId, relativePaths } = params;
  if (relativePaths.length === 0) {
    return { success: true, restoredFiles: 0 };
  }
  const roots = await turnRoots(workspacePath, turnId);
  const groups = groupPathsByRoot({
    workspacePath,
    paths: relativePaths,
    // The turn's own roots are the eligible set here: a path is revertible exactly where
    // it was captured.
    grantedRoots: roots,
  });

  const primary = path.resolve(workspacePath);
  let restored = 0;
  let anyManifest = false;
  let unchecked = false;
  const kept: string[] = [];
  for (const group of groups) {
    const result = await withWorkspaceLock(group.root, () =>
      shadowRevert(group.root, turnId, group.relativePaths),
    );
    if (!result) continue;
    anyManifest = true;
    restored += result.restoredFiles ?? 0;
    unchecked ||= !!result.unchecked;
    kept.push(...result.kept.map((rel) => displayPath(primary, group.root, rel)));
  }

  if (!anyManifest) return { success: false, restoredFiles: 0 };
  return {
    success: true,
    restoredFiles: restored,
    kept,
    ...(unchecked ? { unchecked } : {}),
  };
}

/**
 * A file as it was just before a turn first wrote it, read from that turn's
 * snapshot without touching the work tree (the editor's "Compare" at a
 * checkpoint). `existed: false` when the turn created it. Null when the turn
 * captured nothing for this file.
 */
export async function readSnapshotFile(params: {
  workspacePath: string;
  turnId: string;
  /** Workspace-relative (`../sibling/x` for a granted root), as listSnapshotFiles shows it. */
  relativePath: string;
}): Promise<{ existed: boolean; content: string } | null> {
  const { workspacePath, turnId, relativePath } = params;
  const seg = sanitizeLedgerDirSegment(turnId);
  const roots = await turnRoots(workspacePath, turnId);
  const [group] = groupPathsByRoot({ workspacePath, paths: [relativePath], grantedRoots: roots });
  const rel = group?.relativePaths[0];
  if (!group || !rel) return null;
  const gitDir = shadowGitDir(group.root);
  const manifest = await readManifest(gitDir, seg);
  if (!manifest) return null;
  if (manifest.createdFiles.includes(rel)) return { existed: false, content: "" };
  if (!manifest.filesChanged.includes(rel)) return null;
  const out = await git(["show", `${turnRef(seg)}:${rel}`], group.root, gitEnv(gitDir, group.root));
  return out.exitCode === 0 ? { existed: true, content: out.stdout } : { existed: false, content: "" };
}

/** True when a snapshot exists for this turn (shadow-git store). */
export async function snapshotExists(
  workspacePath: string,
  turnId: string,
): Promise<boolean> {
  if (!workspacePath || !turnId) return false;
  const seg = sanitizeLedgerDirSegment(turnId);
  // A turn that ONLY touched a granted sibling still has a revertible snapshot — it just
  // lives in that root's shadow repo. Checking the primary alone would hide the Revert
  // affordance for exactly the cross-repo edits this release made revertible.
  for (const root of await turnRoots(workspacePath, turnId)) {
    if ((await readManifest(shadowGitDir(root), seg)) != null) return true;
  }
  return false;
}

/**
 * v13.1: the workspace-relative files a turn changed (+ which were newly
 * created). Used by the "revert this turn's file changes" affordance to show
 * what a revert will restore/delete. Null when the turn captured no snapshot.
 */
export async function listSnapshotFiles(
  workspacePath: string,
  turnId: string,
): Promise<{
  filesChanged: string[];
  createdFiles: string[];
  revertedAt?: string;
  /** The files the last revert put back; absent before this was recorded. */
  revertedFiles?: string[];
  /** False when the turn has no record of how it ended (a revert can't check). */
  endRecorded: boolean;
} | null> {
  if (!workspacePath || !turnId) return null;
  const seg = sanitizeLedgerDirSegment(turnId);
  const primary = path.resolve(workspacePath);
  const filesChanged: string[] = [];
  const createdFiles: string[] = [];
  let revertedFiles: string[] | undefined;
  let revertedAt: string | undefined;
  let endRecorded = true;
  let found = false;

  for (const root of await turnRoots(workspacePath, turnId)) {
    const manifest = await readManifest(shadowGitDir(root), seg);
    if (!manifest) continue;
    found = true;
    revertedAt ??= manifest.revertedAt;
    if (!manifest.endHashes) endRecorded = false;
    if (manifest.revertedFiles) {
      revertedFiles = [
        ...(revertedFiles ?? []),
        ...manifest.revertedFiles.map((rel) => displayPath(primary, root, rel)),
      ];
    }
    // Re-express an outside root's paths the way the UI shows them (`../sibling/x`), so
    // the revert list reads as one turn rather than several disjoint sets, and so the
    // strings round-trip back through `revertSnapshotFiles`.
    const toDisplay = (rel: string): string =>
      root === primary
        ? rel
        : path
            .relative(primary, path.join(root, rel))
            .split(path.sep)
            .join("/");
    for (const rel of manifest.filesChanged ?? [])
      filesChanged.push(toDisplay(rel));
    for (const rel of manifest.createdFiles ?? [])
      createdFiles.push(toDisplay(rel));
  }

  if (!found) return null;
  return {
    filesChanged,
    createdFiles,
    endRecorded,
    ...(revertedAt ? { revertedAt } : {}),
    ...(revertedFiles ? { revertedFiles } : {}),
  };
}

async function updateManifests(
  workspacePath: string,
  turnId: string,
  update: (m: SnapshotManifest) => boolean,
): Promise<SnapshotManifest[]> {
  const seg = sanitizeLedgerDirSegment(turnId);
  const changed: SnapshotManifest[] = [];
  for (const root of await turnRoots(workspacePath, turnId)) {
    const gitDir = shadowGitDir(root);
    await withWorkspaceLock(root, async () => {
      const manifest = await readManifest(gitDir, seg);
      if (!manifest || !update(manifest)) return;
      await fs.writeFile(
        turnManifestPath(gitDir, seg),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
      changed.push(manifest);
    });
  }
  return changed;
}

/**
 * Record that the user put this turn's files back (files only; the
 * conversation stays). See `SnapshotManifest.revertedAt`.
 */
export async function markSnapshotReverted(
  workspacePath: string,
  turnId: string,
): Promise<void> {
  if (!workspacePath || !turnId) return;
  await updateManifests(workspacePath, turnId, (m) => {
    m.revertedAt = new Date().toISOString();
    delete m.revertToldAt;
    return true;
  });
}

/**
 * The files of these turns that were reverted since the agent was last told,
 * marked told: the agent hears about a revert once, with the next message, so
 * it does not build on edits that are gone. Workspace-relative, as
 * listSnapshotFiles shows them.
 */
export async function takeUntoldRevertedFiles(
  workspacePath: string,
  turnIds: string[],
): Promise<string[]> {
  if (!workspacePath) return [];
  const out = new Set<string>();
  for (const turnId of turnIds) {
    const listed = await listSnapshotFiles(workspacePath, turnId);
    if (!listed?.revertedAt) continue;
    const told = await updateManifests(workspacePath, turnId, (m) => {
      if (!m.revertedAt || m.revertToldAt) return false;
      m.revertToldAt = new Date().toISOString();
      return true;
    });
    if (told.length === 0) continue;
    // Only what went back: a kept file is still as the agent (or others) left it.
    for (const f of listed.revertedFiles ?? [
      ...listed.filesChanged,
      ...listed.createdFiles,
    ])
      out.add(f);
  }
  return [...out];
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
      await git(["gc", "--quiet", "--prune=now"], workspacePath, {
        GIT_DIR: gitDir,
      });
      logger.info(
        `Pruned ${dropped} expired snapshot turn(s) for ${workspacePath}`,
      );
    }
  } catch (err) {
    logger.warn("snapshot prune failed:", err);
  }
}
