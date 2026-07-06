/**
 * Disk-backed SQLite FTS5 lexical index — the scalable replacement for the
 * in-memory wink-bm25 engine. One standalone DB per workspace under
 * `userData/fts5-index/<key>/index.db` (no drizzle, no migration ledger — the
 * schema is created idempotently on open). Disk-backed ⇒ ~constant low memory at
 * any repo size, incremental per-file updates, and the OOM ceiling is gone.
 *
 * Symbols come from ctags (`ensureSymbolIndex`). Each searchable column stores
 * the PRE-tokenized text (camelCase/snake_case sub-tokens via `tokenizedText`)
 * so FTS5's plain `unicode61` tokenizer reproduces the old sub-token matching.
 * Ranking uses FTS5 `bm25()` with the Tier-1 column weights.
 *
 * The optional Model2Vec embedding lane keeps an in-memory vector side-table
 * (gated + capped); Task 3 makes it per-package LRU.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import log from "electron-log";
import { getUserDataPath } from "@/paths/paths";
import { getCurrentCommitHash } from "@/ipc/utils/git_utils";
import {
  ensureSymbolIndex,
  updateSymbolIndexForFile,
} from "@/lib/index/ctags-index";
import type { SymbolRecord } from "@/lib/index/symbol-types";
import {
  type Bm25BeaconHit,
  type Bm25SearchResult,
  enrichLineContext,
} from "./retrieval-common";
import {
  FTS5_SCHEMA,
  SCHEMA_VERSION,
  BM25_WEIGHTS,
  INSERT_SQL,
  searchableColumns,
  toMatch,
} from "./fts5-core";
import { detectPackages, type PackageMap } from "./package-boundaries";

const logger = log.scope("fts5-index");

export interface FtsSearchOpts {
  maxResults: number;
  /** Candidate-set rerank: score only these absolute files. */
  restrictToFiles?: string[];
  /** Per-package lexical scope: restrict to one package root. */
  package?: string;
}

type Handle = {
  db: Database.Database;
  commitHash: string | null;
  filesIndexed: number;
  /** Sub-package boundary map for this workspace (fills the `package` column). */
  pkgMap: PackageMap | null;
};

const handles = new Map<number, Handle>();
const dirty = new Set<number>();

function workspaceKey(root: string): string {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
}

function dbPath(root: string): string {
  return path.join(getUserDataPath(), "fts5-index", workspaceKey(root), "index.db");
}

/** Open + idempotently init the per-workspace DB. null if FTS5 is unavailable. */
function openDb(root: string): Database.Database | null {
  try {
    const p = dbPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const db = new Database(p, { timeout: 10000 });
    db.pragma("journal_mode = WAL");
    db.exec(FTS5_SCHEMA);
    // Drop + recreate when the column shape changed (a normal rebuild then
    // repopulates). Guards against querying an old index with the wrong schema.
    const ver = (
      db.prepare("SELECT value FROM meta WHERE key = 'schemaVer'").get() as
        | { value: string }
        | undefined
    )?.value;
    if (ver !== SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS symbols");
      db.exec(FTS5_SCHEMA);
      db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schemaVer', ?)",
      ).run(SCHEMA_VERSION);
    }
    return db;
  } catch (e) {
    logger.warn("FTS5 unavailable — grep falls back to ripgrep order:", e);
    return null;
  }
}

/** Read each file once and return line-content (1-indexed) for its symbols. */
async function snippetsByFile(
  workspaceRootAbs: string,
  symbols: SymbolRecord[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  await Promise.all(
    [...new Set(symbols.map((s) => s.path))].map(async (rel) => {
      try {
        const raw = await fsp.readFile(path.join(workspaceRootAbs, rel), "utf-8");
        out.set(rel, raw.split("\n"));
      } catch {
        out.set(rel, []);
      }
    }),
  );
  return out;
}

/** Row values for one symbol: tokenized search columns + UNINDEXED metadata. */
function rowFor(
  s: SymbolRecord,
  workspaceRootAbs: string,
  lines: string[] | undefined,
  pkg: string,
): [string, string, string, string, string, string, number, string] {
  const lineText = lines?.[Math.max(0, s.line - 1)]?.trim().slice(0, 4000) ?? "";
  const snippet = lineText || (s.signature ?? "");
  return [
    ...searchableColumns(s.name, s.signature ?? "", snippet),
    // Canonical absolute path so the candidate-set `abs_file IN (…)` filter
    // matches what callers pass through path.resolve — see searchFts5.
    path.resolve(workspaceRootAbs, s.path),
    s.path,
    s.line,
    pkg,
  ];
}

/** Full rebuild from ctags symbols. Embeddings are built lazily per package. */
async function rebuild(
  db: Database.Database,
  workspaceRootAbs: string,
): Promise<{ filesIndexed: number; commitHash: string | null; pkgMap: PackageMap | null }> {
  const t0 = Date.now();
  let symbols: SymbolRecord[] = [];
  try {
    symbols = (await ensureSymbolIndex(workspaceRootAbs)).symbols;
  } catch (e) {
    logger.warn("ctags symbol index unavailable:", e);
  }

  let pkgMap: PackageMap | null = null;
  try {
    pkgMap = await detectPackages(workspaceRootAbs);
  } catch (e) {
    logger.debug("package boundary detection failed; using single root:", e);
  }

  const lineCache = await snippetsByFile(workspaceRootAbs, symbols);

  db.exec("DELETE FROM symbols");
  const insert = db.prepare(INSERT_SQL);
  const files = new Set<string>();
  const insertAll = db.transaction((rows: SymbolRecord[]) => {
    for (const s of rows) {
      const pkg = pkgMap?.packageFor(s.path) ?? ".";
      insert.run(...rowFor(s, workspaceRootAbs, lineCache.get(s.path), pkg));
      files.add(s.path);
    }
  });
  insertAll(symbols);

  let commitHash: string | null = null;
  try {
    commitHash = await getCurrentCommitHash({ path: workspaceRootAbs });
  } catch {
    commitHash = null;
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('commitHash', ?)").run(
    commitHash ?? "",
  );

  logger.info("fts5 rebuild complete", {
    symbols: symbols.length,
    filesIndexed: files.size,
    packages: pkgMap?.roots.length ?? 1,
    elapsedMs: Date.now() - t0,
  });
  return { filesIndexed: files.size, commitHash, pkgMap };
}

/** Get a warm handle, (re)building if dirty/stale. null when FTS5 unavailable. */
async function ensureHandle(
  workspaceId: number,
  workspaceRootAbs: string,
): Promise<Handle | null> {
  let handle = handles.get(workspaceId);
  const isDirty = dirty.has(workspaceId);

  if (handle && !isDirty) {
    let head: string | null = null;
    try {
      head = await getCurrentCommitHash({ path: workspaceRootAbs });
    } catch {
      head = null;
    }
    if (handle.commitHash !== undefined && head !== handle.commitHash) {
      // HEAD moved — rebuild below.
    } else {
      return handle;
    }
  }

  if (!handle) {
    const db = openDb(workspaceRootAbs);
    if (!db) return null;
    handle = { db, commitHash: null, filesIndexed: 0, pkgMap: null };
    handles.set(workspaceId, handle);
  }

  try {
    const { filesIndexed, commitHash, pkgMap } = await rebuild(handle.db, workspaceRootAbs);
    handle.filesIndexed = filesIndexed;
    handle.commitHash = commitHash;
    handle.pkgMap = pkgMap;
    dirty.delete(workspaceId);
    return handle;
  } catch (e) {
    logger.warn("fts5 rebuild failed:", e);
    return null;
  }
}

export async function searchFts5(
  workspaceId: number,
  workspaceRootAbs: string,
  query: string,
  opts: FtsSearchOpts,
): Promise<Bm25SearchResult | null> {
  const handle = await ensureHandle(workspaceId, workspaceRootAbs);
  if (!handle) return null;
  const match = toMatch(query);
  if (!match) return { hits: [], totalMatches: 0, filesIndexed: handle.filesIndexed };

  const scanLimit = Math.max(opts.maxResults, 200);
  const where: string[] = ["symbols MATCH ?"];
  const params: Array<string | number> = [match];
  if (opts.restrictToFiles?.length) {
    // Match the canonical form stored at index time (rowFor → path.resolve).
    const candidates = opts.restrictToFiles.map((f) => path.resolve(f));
    where.push(`abs_file IN (${candidates.map(() => "?").join(",")})`);
    params.push(...candidates);
  }
  if (opts.package) {
    where.push("package = ?");
    params.push(opts.package);
  }
  const sql =
    `SELECT abs_file AS file, line, bm25(symbols, ${BM25_WEIGHTS.join(", ")}) AS rank ` +
    `FROM symbols WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`;
  params.push(scanLimit);

  let rows: Array<{ file: string; line: number; rank: number }>;
  try {
    rows = handle.db.prepare(sql).all(...params) as typeof rows;
  } catch (e) {
    logger.warn("fts5 search failed:", e);
    return null;
  }
  if (rows.length === 0) {
    return { hits: [], totalMatches: 0, filesIndexed: handle.filesIndexed };
  }

  const hits: Bm25BeaconHit[] = [];
  for (const r of rows) {
    if (hits.length >= opts.maxResults) break;
    const ctx = await enrichLineContext(r.file, r.line);
    hits.push({ score: -r.rank, file: r.file, line: r.line, ...ctx });
  }
  return { hits, totalMatches: rows.length, filesIndexed: handle.filesIndexed };
}

export function markFtsDirty(workspaceId: number): void {
  dirty.add(workspaceId);
}

export function invalidateFts(workspaceId: number): void {
  const h = handles.get(workspaceId);
  if (h) {
    try {
      h.db.close();
    } catch {
      /* ignore */
    }
    handles.delete(workspaceId);
  }
  dirty.add(workspaceId);
}

/**
 * Incremental per-file update: re-tag one file and replace just its rows.
 * Keeps the lexical index fresh without a full rebuild (the file-watcher path).
 */
export async function updateFtsForFile(
  workspaceId: number,
  workspaceRootAbs: string,
  relFile: string,
): Promise<void> {
  const handle = handles.get(workspaceId);
  if (!handle) {
    dirty.add(workspaceId); // no warm index yet — rebuild on next search
    return;
  }
  try {
    const cache = await updateSymbolIndexForFile(workspaceRootAbs, relFile);
    const fileSymbols = cache.symbols.filter((s) => s.path === relFile);
    const lineCache = await snippetsByFile(workspaceRootAbs, fileSymbols);
    const pkg = handle.pkgMap?.packageFor(relFile) ?? ".";
    const insert = handle.db.prepare(INSERT_SQL);
    const tx = handle.db.transaction(() => {
      handle.db.prepare("DELETE FROM symbols WHERE rel_file = ?").run(relFile);
      for (const s of fileSymbols) {
        insert.run(...rowFor(s, workspaceRootAbs, lineCache.get(s.path), pkg));
      }
    });
    tx();
  } catch (e) {
    logger.warn("fts5 incremental update failed; marking dirty:", e);
    dirty.add(workspaceId);
  }
}
