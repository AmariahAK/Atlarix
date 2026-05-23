/**
 * Universal Ctags symbol index — build, cache, single-flight per workspace path.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import log from "electron-log";
import { getProjectFiles } from "@/ipc/utils/project-files";
import { getFilesRecursively } from "@/ipc/utils/file_utils";
import { getCurrentCommitHash } from "@/ipc/utils/git_utils";
import { resolveCtagsPath } from "@/lib/native/resolve-ctags-path";
import { parseCtagsJsonOutput } from "./ctags-parse";
import type { SymbolIndexCache, SymbolRecord } from "./symbol-types";

const execFileAsync = promisify(execFile);
const logger = log.scope("ctags-index");

const SYMBOLS_FILE = "symbols.json";
const ATLARIX_DIR = ".atlarix";

const CTAGS_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".cs", ".rb", ".php", ".swift", ".ex", ".exs",
  ".vue", ".svelte",
]);

const inflightByPath = new Map<string, Promise<SymbolIndexCache>>();
const memoryByPath = new Map<string, SymbolIndexCache>();
const dirtyPaths = new Set<string>();

function symbolsCachePath(projectPath: string): string {
  return path.join(projectPath, ATLARIX_DIR, SYMBOLS_FILE);
}

export function invalidateSymbolIndex(projectPath: string): void {
  dirtyPaths.add(projectPath);
  memoryByPath.delete(projectPath);
  inflightByPath.delete(projectPath);
}

export function markSymbolIndexDirty(projectPath: string): void {
  dirtyPaths.add(projectPath);
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
  const dir = path.join(projectPath, ATLARIX_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(symbolsCachePath(projectPath), JSON.stringify(cache, null, 2), "utf-8");
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

  const filtered = relFiles.filter((f) =>
    CTAGS_EXTENSIONS.has(path.extname(f).toLowerCase()),
  );
  if (filtered.length === 0) {
    return { symbols: [] };
  }

  const listPath = path.join(projectPath, ATLARIX_DIR, ".ctags-filelist");
  await fs.mkdir(path.dirname(listPath), { recursive: true });
  await fs.writeFile(
    listPath,
    filtered.map((f) => f.replace(/\\/g, "/")).join("\n"),
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

export async function ensureSymbolIndex(projectPath: string): Promise<SymbolIndexCache> {
  const normPath = path.resolve(projectPath);

  if (!dirtyPaths.has(normPath)) {
    const mem = memoryByPath.get(normPath);
    if (mem) return mem;
    const disk = await loadDiskCache(normPath);
    if (disk && !(await isCacheStale(normPath, disk))) {
      memoryByPath.set(normPath, disk);
      return disk;
    }
  }

  const existing = inflightByPath.get(normPath);
  if (existing) return existing;

  const promise = (async (): Promise<SymbolIndexCache> => {
    logger.info("ensureSymbolIndex: building", { projectPath: normPath });
    const t0 = Date.now();

    let { files } = await getProjectFiles(normPath);
    if (files.length === 0) {
      files = getFilesRecursively(normPath, normPath).map((f) => f.replace(/\\/g, "/"));
    }
    const { symbols, ctagsVersion } = await runCtags(normPath, files);

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
      },
      symbols,
    };

    await saveDiskCache(normPath, cache);
    memoryByPath.set(normPath, cache);
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
  const ext = path.extname(normRel).toLowerCase();
  if (CTAGS_EXTENSIONS.has(ext)) {
    try {
      await fs.access(path.join(normPath, normRel));
      const { symbols, ctagsVersion } = await runCtags(normPath, [normRel]);
      newFileSymbols = symbols;
      if (ctagsVersion) cache.manifest.ctagsVersion = ctagsVersion;
    } catch {
      /* deleted or unreadable — drop symbols for this file */
    }
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

  try {
    cache.manifest.commitHash = await getCurrentCommitHash({ path: normPath });
  } catch {
    /* ignore */
  }

  await saveDiskCache(normPath, cache);
  memoryByPath.set(normPath, cache);
  dirtyPaths.delete(normPath);
  return cache;
}

export async function ensureSymbolIndexForWorkspaceId(
  workspaceId: number,
): Promise<SymbolIndexCache | null> {
  const { db } = await import("@/db");
  const { apps } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { getAtlarixAppPath } = await import("@/paths/paths");

  const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
  if (!app) return null;
  const projectPath = getAtlarixAppPath(app.path);
  return ensureSymbolIndex(projectPath);
}
