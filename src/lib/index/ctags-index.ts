/**
 * Universal Ctags symbol index — build, cache, single-flight per workspace path.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import log from "electron-log";
import { getProjectFiles } from "@/ipc/utils/project-files";
import { getFilesRecursively } from "@/ipc/utils/file_utils";
import { getCurrentCommitHash } from "@/ipc/utils/git_utils";
import { getUserDataPath } from "@/paths/paths";
import { resolveCtagsPath } from "@/lib/native/resolve-ctags-path";
import { parseCtagsJsonOutput } from "./ctags-parse";
import type { SymbolIndexCache, SymbolRecord } from "./symbol-types";

const execFileAsync = promisify(execFile);
const logger = log.scope("ctags-index");

const SYMBOLS_FILE = "symbols.json";
const ATLARIX_DIR = ".atlarix";

/**
 * No language/extension allowlist: universal-ctags auto-detects ~150 languages
 * and silently skips files it doesn't recognize. The only gate is size — the
 * old extension allowlist doubled as an implicit huge-file guard, so keep that
 * property explicitly (large blobs/assets would slow tagging for no symbols).
 */
const MAX_CTAGS_FILE_BYTES = 2 * 1024 * 1024;

const inflightByPath = new Map<string, Promise<SymbolIndexCache>>();
const memoryByPath = new Map<string, SymbolIndexCache>();
const dirtyPaths = new Set<string>();

/**
 * Keep only the most-recently-used workspaces' symbol caches in memory. Each
 * cache holds the whole repo's `SymbolRecord[]` (huge on a big repo), so an
 * unbounded map made RSS grow across every workspace opened in a session. An
 * evicted workspace just reloads from `symbols.json`/ctags on next access.
 */
const MAX_CACHED_WORKSPACES = 3;
function rememberSymbolCache(normPath: string, cache: SymbolIndexCache): void {
  memoryByPath.delete(normPath); // re-insert at the end (LRU recency)
  memoryByPath.set(normPath, cache);
  while (memoryByPath.size > MAX_CACHED_WORKSPACES) {
    const oldest = memoryByPath.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === normPath) break;
    memoryByPath.delete(oldest);
  }
}

/** Per-workspace userData dir for the ctags index (mirrors the FTS5 index). */
function ctagsCacheDir(projectPath: string): string {
  const key = createHash("sha256")
    .update(path.resolve(projectPath))
    .digest("hex")
    .slice(0, 16);
  return path.join(getUserDataPath(), "ctags-index", key);
}

function symbolsCachePath(projectPath: string): string {
  // Relocated out of <workspace>/.atlarix (v14.8.6): the in-workspace file
  // polluted foreign repos and risked git-LFS; the .atlarix gitignore only
  // protects Atlarix's own repo. Now under userData like the FTS5 index.
  return path.join(ctagsCacheDir(projectPath), SYMBOLS_FILE);
}

/** Best-effort one-time cleanup of the legacy in-workspace cache file. */
function cleanupLegacySymbolsCache(projectPath: string): void {
  fs.unlink(path.join(projectPath, ATLARIX_DIR, SYMBOLS_FILE)).catch(() => {});
}

export function invalidateSymbolIndex(projectPath: string): void {
  dirtyPaths.add(projectPath);
  memoryByPath.delete(projectPath);
  inflightByPath.delete(projectPath);
}

function normalizeRelPath(relFile: string): string {
  return relFile.replace(/\\/g, "/").replace(/^\//, "");
}

async function loadDiskCache(projectPath: string): Promise<SymbolIndexCache | null> {
  try {
    const raw = await fs.readFile(symbolsCachePath(projectPath), "utf-8");
    const parsed = JSON.parse(raw) as SymbolIndexCache;
    if (!parsed?.symbols?.length || !parsed.manifest) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveDiskCache(projectPath: string, cache: SymbolIndexCache): Promise<void> {
  await fs.mkdir(ctagsCacheDir(projectPath), { recursive: true });
  // No pretty-print — this is a machine cache, not a committed artifact.
  await fs.writeFile(symbolsCachePath(projectPath), JSON.stringify(cache), "utf-8");
  cleanupLegacySymbolsCache(projectPath);
}

async function isCacheStale(projectPath: string, cache: SymbolIndexCache): Promise<boolean> {
  if (dirtyPaths.has(projectPath)) return true;
  let head: string | null = null;
  try {
    head = await getCurrentCommitHash({ path: projectPath });
  } catch {
    head = null;
  }
  if (head && cache.manifest.commitHash && head !== cache.manifest.commitHash) {
    return true;
  }
  return false;
}

async function runCtags(
  projectPath: string,
  relFiles: string[],
): Promise<{ symbols: SymbolRecord[]; ctagsVersion?: string }> {
  const ctagsBin = resolveCtagsPath();
  if (!ctagsBin) {
    throw new Error(
      "Universal Ctags not found. Run `node scripts/fetch-ctags.mjs` or install universal-ctags.",
    );
  }

  if (relFiles.length === 0) {
    return { symbols: [] };
  }

  const listPath = path.join(ctagsCacheDir(projectPath), ".ctags-filelist");
  await fs.mkdir(path.dirname(listPath), { recursive: true });
  await fs.writeFile(
    listPath,
    relFiles.map((f) => f.replace(/\\/g, "/")).join("\n"),
    "utf-8",
  );

  const args = [
    "--output-format=json",
    "--fields=+nKlzS",
    "--extras=+q",
    "-f",
    "-",
    "-L",
    listPath,
  ];

  let ctagsVersion: string | undefined;
  try {
    const versionOut = await execFileAsync(ctagsBin, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    ctagsVersion = versionOut.stdout.split("\n")[0]?.trim();
  } catch {
    /* ignore */
  }

  let stdout: string;
  try {
    const result = await execFileAsync(ctagsBin, args, {
      cwd: projectPath,
      encoding: "utf-8",
      maxBuffer: 100 * 1024 * 1024,
      timeout: 120_000,
    });
    stdout = result.stdout;
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }

  const symbols = parseCtagsJsonOutput(stdout, projectPath);
  return { symbols, ctagsVersion };
}

/** Stat mtimeMs + size for every discovered file (bounded concurrency). */
async function collectFileMeta(
  projectPath: string,
  relFiles: string[],
): Promise<Record<string, { mtimeMs: number; size: number }>> {
  const out: Record<string, { mtimeMs: number; size: number }> = {};
  const CONCURRENCY = 64;
  for (let i = 0; i < relFiles.length; i += CONCURRENCY) {
    const batch = relFiles.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (f) => {
        try {
          const st = await fs.stat(path.join(projectPath, f));
          out[normalizeRelPath(f)] = { mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          /* unreadable — treat as absent */
        }
      }),
    );
  }
  return out;
}

export async function ensureSymbolIndex(projectPath: string): Promise<SymbolIndexCache> {
  const normPath = path.resolve(projectPath);

  let staleDisk: SymbolIndexCache | null = null;
  if (!dirtyPaths.has(normPath)) {
    const mem = memoryByPath.get(normPath);
    if (mem) return mem;
    const disk = await loadDiskCache(normPath);
    if (disk && !(await isCacheStale(normPath, disk))) {
      rememberSymbolCache(normPath, disk);
      return disk;
    }
    staleDisk = disk;
  } else {
    staleDisk = await loadDiskCache(normPath);
  }

  const existing = inflightByPath.get(normPath);
  if (existing) return existing;

  const promise = (async (): Promise<SymbolIndexCache> => {
    logger.info("ensureSymbolIndex: building", { projectPath: normPath });
    const t0 = Date.now();

    let { files } = await getProjectFiles(normPath);
    // Validate that discovered paths actually resolve under the workspace.
    // fd / rg sometimes return paths that mishandle Windows drives; the legacy
    // recursive scan is a known-good fallback. Perf: SAMPLE a handful rather than
    // `existsSync`-ing every file — on a big repo (tens of thousands of files)
    // the exhaustive per-file sync stat froze the main event loop on the first
    // grep. A bad fd/rg mapping affects all paths uniformly, so a sample detects
    // it just as reliably.
    const sample = files.slice(0, 20);
    const sampleResolvable =
      files.length > 0 &&
      sample.every((f) => {
        try {
          return fsSync.existsSync(path.join(normPath, f));
        } catch {
          return false;
        }
      });
    if (!sampleResolvable) {
      files = getFilesRecursively(normPath, normPath).map((f) => f.replace(/\\/g, "/"));
    }

    // v10.1: content-change diffing — when a prior cache carries per-file
    // mtimes, only re-tag changed/added files and drop deleted ones instead
    // of re-running ctags across the whole repo on every commit change.
    const meta = await collectFileMeta(normPath, files);
    const eligible = Object.keys(meta).filter(
      (f) => meta[f].size <= MAX_CTAGS_FILE_BYTES,
    );
    // The mtime ledger only tracks indexed (size-eligible) files so the
    // incremental diff below stays consistent with what ctags actually saw.
    const fileMtimes: Record<string, number> = {};
    for (const f of eligible) fileMtimes[f] = meta[f].mtimeMs;
    const prior = staleDisk?.manifest.fileMtimes ? staleDisk : null;
    let symbols: SymbolRecord[];
    let ctagsVersion: string | undefined;
    if (prior) {
      const priorMtimes = prior.manifest.fileMtimes!;
      const changed = Object.keys(fileMtimes).filter(
        (f) => priorMtimes[f] !== fileMtimes[f],
      );
      const removed = new Set(
        Object.keys(priorMtimes).filter((f) => !(f in fileMtimes)),
      );
      const incrementalWorthIt =
        changed.length <= Math.max(50, Object.keys(fileMtimes).length * 0.5);
      if (incrementalWorthIt) {
        const result = changed.length > 0
          ? await runCtags(normPath, changed)
          : { symbols: [] as SymbolRecord[], ctagsVersion: prior.manifest.ctagsVersion };
        ctagsVersion = result.ctagsVersion ?? prior.manifest.ctagsVersion;
        const changedSet = new Set(changed.map(normalizeRelPath));
        symbols = [
          ...prior.symbols.filter((s) => {
            const p = normalizeRelPath(s.path);
            return !changedSet.has(p) && !removed.has(p);
          }),
          ...result.symbols,
        ];
        logger.info("ensureSymbolIndex: incremental refresh", {
          projectPath: normPath,
          changed: changed.length,
          removed: removed.size,
        });
      } else {
        const result = await runCtags(normPath, eligible);
        symbols = result.symbols;
        ctagsVersion = result.ctagsVersion;
      }
    } else {
      const result = await runCtags(normPath, eligible);
      symbols = result.symbols;
      ctagsVersion = result.ctagsVersion;
    }

    let commitHash: string | null = null;
    try {
      commitHash = await getCurrentCommitHash({ path: normPath });
    } catch {
      commitHash = null;
    }

    const cache: SymbolIndexCache = {
      manifest: {
        projectPath: normPath,
        timestamp: Date.now(),
        fileCount: files.length,
        symbolCount: symbols.length,
        commitHash,
        ctagsVersion,
        engine: "ctags",
        fileMtimes,
      },
      symbols,
    };

    await saveDiskCache(normPath, cache);
    rememberSymbolCache(normPath, cache);
    dirtyPaths.delete(normPath);
    logger.info("ensureSymbolIndex: complete", {
      projectPath: normPath,
      elapsedMs: Date.now() - t0,
      symbols: symbols.length,
    });
    return cache;
  })().finally(() => {
    inflightByPath.delete(normPath);
  });

  inflightByPath.set(normPath, promise);
  return promise;
}

export function getSymbolsForFile(cache: SymbolIndexCache, relPath: string): SymbolRecord[] {
  const norm = relPath.replace(/\\/g, "/").replace(/^\//, "");
  return cache.symbols.filter((s) => s.path.replace(/\\/g, "/") === norm);
}

/**
 * The symbol that encloses a given 1-indexed line in a file — i.e. the function
 * or class the match lives inside (used to annotate grep hits zoekt-style).
 * Prefers the innermost symbol whose `[line, endLine]` range contains the line;
 * when `endLine` is missing (sparse on some ctags kinds) it falls back to the
 * nearest preceding definition. Returns null when the file has no symbols.
 */
export function findEnclosingSymbol(
  cache: SymbolIndexCache,
  relPath: string,
  line: number,
): SymbolRecord | null {
  const fileSymbols = getSymbolsForFile(cache, relPath);
  if (fileSymbols.length === 0) return null;

  // Innermost ranged match: deepest start line among symbols whose range covers it.
  let ranged: SymbolRecord | null = null;
  for (const s of fileSymbols) {
    if (s.endLine != null && s.line <= line && line <= s.endLine) {
      if (!ranged || s.line > ranged.line) ranged = s;
    }
  }
  if (ranged) return ranged;

  // Fallback: nearest definition at or above the line (no reliable end range).
  let preceding: SymbolRecord | null = null;
  for (const s of fileSymbols) {
    if (s.line <= line && (!preceding || s.line > preceding.line)) preceding = s;
  }
  return preceding;
}

export function findSymbolsByName(
  cache: SymbolIndexCache,
  name: string,
  opts?: { kind?: string; limit?: number },
): SymbolRecord[] {
  const q = name.toLowerCase();
  const limit = opts?.limit ?? 50;
  return cache.symbols
    .filter((s) => {
      if (s.name.toLowerCase() !== q && !s.name.toLowerCase().includes(q)) return false;
      if (opts?.kind && s.kind !== opts.kind) return false;
      return true;
    })
    .slice(0, limit);
}

export async function isSymbolIndexWarm(projectPath: string): Promise<boolean> {
  const normPath = path.resolve(projectPath);
  const mem = memoryByPath.get(normPath);
  const cached = mem ?? (await loadDiskCache(normPath));
  if (!cached?.symbols?.length || !cached.manifest) return false;
  return !(await isCacheStale(normPath, cached));
}

/**
 * Incrementally refresh ctags symbols for a single workspace-relative file.
 * Removes prior symbols for that path, re-runs ctags on the file (or drops symbols if deleted).
 */
export async function updateSymbolIndexForFile(
  projectPath: string,
  relFile: string,
): Promise<SymbolIndexCache> {
  const normPath = path.resolve(projectPath);
  const normRel = normalizeRelPath(relFile);

  let cache =
    memoryByPath.get(normPath) ??
  (await loadDiskCache(normPath)) ??
    ({
      manifest: {
        projectPath: normPath,
        timestamp: Date.now(),
        fileCount: 0,
        symbolCount: 0,
        engine: "ctags" as const,
      },
      symbols: [],
    } satisfies SymbolIndexCache);

  let newFileSymbols: SymbolRecord[] = [];
  let touchedMtime: number | null = null;
  try {
    const st = await fs.stat(path.join(normPath, normRel));
    if (st.size <= MAX_CTAGS_FILE_BYTES) {
      touchedMtime = st.mtimeMs;
      const { symbols, ctagsVersion } = await runCtags(normPath, [normRel]);
      newFileSymbols = symbols;
      if (ctagsVersion) cache.manifest.ctagsVersion = ctagsVersion;
    }
  } catch {
    /* deleted or unreadable — drop symbols for this file */
  }

  cache = {
    ...cache,
    symbols: [
      ...cache.symbols.filter((s) => normalizeRelPath(s.path) !== normRel),
      ...newFileSymbols,
    ],
    manifest: {
      ...cache.manifest,
      timestamp: Date.now(),
      symbolCount: 0,
      fileCount: 0,
    },
  };
  cache.manifest.symbolCount = cache.symbols.length;
  cache.manifest.fileCount = new Set(cache.symbols.map((s) => normalizeRelPath(s.path))).size;
  // Keep the mtime ledger coherent for the next incremental refresh.
  if (cache.manifest.fileMtimes) {
    if (touchedMtime != null) {
      cache.manifest.fileMtimes[normRel] = touchedMtime;
    } else {
      delete cache.manifest.fileMtimes[normRel];
    }
  }

  try {
    cache.manifest.commitHash = await getCurrentCommitHash({ path: normPath });
  } catch {
    /* ignore */
  }

  await saveDiskCache(normPath, cache);
  rememberSymbolCache(normPath, cache);
  dirtyPaths.delete(normPath);
  return cache;
}

export async function ensureSymbolIndexForWorkspaceId(
  workspaceId: number,
  options?: { scopePath?: string },
): Promise<SymbolIndexCache | null> {
  const { db } = await import("@/db");
  const { apps } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { getAtlarixAppPath } = await import("@/paths/paths");

  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (!app) return null;
  const workspacePath = getAtlarixAppPath(app.path);
  const scope = options?.scopePath?.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (scope) {
    return ensureSymbolIndex(path.join(workspacePath, scope));
  }
  return ensureSymbolIndex(workspacePath);
}
