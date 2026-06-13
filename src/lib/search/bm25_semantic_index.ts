/**
 * Blueprint-backed BM25 index for semantic search (ctags symbols + snippets).
 * Cache is invalidated when symbol index or blueprint changes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import createBm25Engine from "wink-bm25-text-search";
import log from "electron-log";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { resolveAppPath } from "@/paths/paths";
import { getCurrentCommitHash } from "@/ipc/utils/git_utils";
import { ensureSymbolIndex } from "@/lib/index/ctags-index";
import { blueprintToRagGraph, getCodeSnippetForBuildNode } from "@/lib/blueprint/blueprint-rag";
import { embedQuery, cosineSim } from "./static-embeddings";
import { ensureSemanticModel } from "./model2vec-runtime";

const logger = log.scope("bm25-semantic-index");

const CONTEXT_LINES = 3;

export type Bm25BeaconHit = {
  score: number;
  file: string;
  line: number;
  content: string;
  contextBefore: string[];
  contextAfter: string[];
};

type NodeMeta = {
  absFile: string;
  line: number;
};

type CachedIndex = {
  engine: ReturnType<typeof createBm25Engine>;
  meta: NodeMeta[];
  filesIndexed: number;
  /** When set, index is discarded if git HEAD changes (cheap staleness check). */
  commitHash?: string | null;
  /** Optional Model2Vec per-doc embeddings (semanticRecall): nDocs × embDim. */
  docVectors?: Float32Array | null;
  embDim?: number;
};

const indexByWorkspaceId = new Map<number, CachedIndex>();
const bm25DirtyByWorkspaceId = new Set<number>();

/** Mark BM25 stale without dropping the in-memory index until the next search. */
export function markBm25Dirty(workspaceId: number): void {
  bm25DirtyByWorkspaceId.add(workspaceId);
}

export function invalidateBm25Index(workspaceId: number): void {
  indexByWorkspaceId.delete(workspaceId);
  bm25DirtyByWorkspaceId.add(workspaceId);
}

function normalizeFs(p: string): string {
  return path.normalize(p).replace(/\\/g, "/");
}

export async function resolveWorkspaceIdFromRoot(
  workspaceRootAbs: string,
): Promise<number | null> {
  const want = normalizeFs(path.resolve(workspaceRootAbs));
  const rows = await db.select({ id: apps.id, storedPath: apps.path }).from(apps);
  for (const row of rows) {
    const abs = normalizeFs(resolveAppPath(row.storedPath));
    if (abs === want) return row.id;
  }
  return null;
}

/**
 * v13.2: emit each word PLUS its camelCase/snake_case sub-tokens so
 * multi-word queries match compound identifiers ("auth callback" →
 * `handleAuthCallback`). The full lowercased token stays first — exact-name
 * queries keep their strongest signal; generic sub-tokens ("handle", "get")
 * are naturally down-weighted by BM25's IDF as their document frequency
 * rises. Applied to BOTH documents and queries via definePrepTasks.
 * Exported for the tokenizer unit test only.
 */
export function tokenizeForBm25(text: string): string[] {
  const out: string[] = [];
  for (const word of String(text).split(/[^a-zA-Z0-9_]+/)) {
    if (!word) continue;
    const lower = word.toLowerCase();
    if (lower.length > 1) out.push(lower);
    const subs = word
      .split(/_+/)
      .flatMap((p) =>
        p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/),
      );
    if (subs.length > 1) {
      for (const sub of subs) {
        const s = sub.toLowerCase();
        if (s.length > 1 && s !== lower) out.push(s);
      }
    }
  }
  return out;
}

/**
 * v12 S20 (Tier 6): identifier stop-set — symbols whose WHOLE name is one of
 * these generic words get the name indexed at weight 1 instead of name:4
 * (a `handle`/`process`/`get` symbol shouldn't outrank a specific match on
 * topic queries; the 4x multiplier made generic names dominate room scoring).
 * Specific names (`handleAuthCallback`, `processPayment`) tokenize as single
 * camel/snake tokens and are NOT in this set — they keep the full weight.
 */
const GENERIC_IDENTIFIER_NAMES = new Set([
  "handle", "handler", "process", "run", "exec", "execute", "init", "setup",
  "get", "set", "make", "do", "call", "apply", "main", "start", "stop",
  "create", "update", "delete", "add", "remove", "load", "save", "fetch",
  "send", "read", "write", "parse", "render", "build", "check", "test",
  "data", "value", "item", "index", "key", "result", "callback", "cb", "fn",
  "util", "utils", "helper", "helpers", "config", "options", "params",
  "new", "default",
]);

export function isGenericIdentifierName(name: string): boolean {
  return GENERIC_IDENTIFIER_NAMES.has(name.trim().toLowerCase());
}

async function enrichLineContext(
  absFile: string,
  line: number,
): Promise<Pick<Bm25BeaconHit, "content" | "contextBefore" | "contextAfter">> {
  try {
    const raw = await fs.readFile(absFile, "utf-8");
    const lines = raw.split("\n");
    const idx = Math.max(0, line - 1);
    if (idx >= lines.length) {
      return { content: "", contextBefore: [], contextAfter: [] };
    }
    return {
      content: lines[idx].trim(),
      contextBefore: lines.slice(Math.max(0, idx - CONTEXT_LINES), idx),
      contextAfter: lines.slice(
        idx + 1,
        Math.min(lines.length, idx + CONTEXT_LINES + 1),
      ),
    };
  } catch {
    return { content: "", contextBefore: [], contextAfter: [] };
  }
}

async function buildIndex(
  workspaceId: number,
  workspaceRootAbs: string,
): Promise<CachedIndex | null> {
  const t0 = Date.now();

  let symbolDocs: Array<{
    name: string;
    kind: string;
    scope: string;
    path: string;
    signature: string;
    snippet: string;
    absFile: string;
    line: number;
  }> = [];

  try {
    const symbolIndex = await ensureSymbolIndex(workspaceRootAbs);
    for (const s of symbolIndex.symbols) {
      const absFile = path.join(workspaceRootAbs, s.path);
      let snippet = s.signature ?? "";
      try {
        const raw = await fs.readFile(absFile, "utf-8");
        const lines = raw.split("\n");
        const idx = Math.max(0, s.line - 1);
        if (lines[idx]) snippet = lines[idx].trim().slice(0, 4000);
      } catch {
        /* ignore read errors */
      }
      symbolDocs.push({
        name: s.name,
        kind: s.kind,
        scope: s.scope ?? "",
        path: s.path,
        signature: s.signature ?? "",
        snippet,
        absFile,
        line: s.line,
      });
    }
  } catch (e) {
    logger.warn("BM25: ctags index unavailable, falling back to blueprint beacons", e);
  }

  const engine = createBm25Engine();
  engine.defineConfig({
    // v12 S20: `nameGeneric` carries stop-set names at weight 1 (see
    // GENERIC_IDENTIFIER_NAMES); specific names keep the full name weight.
    // Tier-1 reweight: symbol NAMES carry the most query intent for structural
    // search (name 4→5); the noisier snippet/scope fields are damped so a name
    // match outranks an incidental snippet/scope match for "where is X" queries.
    fldWeights: { name: 5, nameGeneric: 1, signature: 2, path: 1, snippet: 1.5, kind: 1, scope: 0.5 },
  });
  engine.definePrepTasks([tokenizeForBm25]);

  const meta: NodeMeta[] = [];
  // Per-doc text for the optional Model2Vec embedding lane (semanticRecall).
  const docTexts: string[] = [];
  let docId = 0;
  const filesSeen = new Set<string>();

  if (symbolDocs.length > 0) {
    for (const s of symbolDocs) {
      const generic = isGenericIdentifierName(s.name);
      engine.addDoc(
        {
          name: generic ? "" : s.name,
          nameGeneric: generic ? s.name : "",
          kind: s.kind,
          scope: s.scope,
          path: s.path,
          signature: s.signature,
          snippet: s.snippet,
        },
        docId,
      );
      meta.push({ absFile: s.absFile, line: s.line });
      docTexts.push(`${s.name} ${s.signature} ${s.snippet}`);
      filesSeen.add(s.absFile);
      docId += 1;
    }
  } else {
    const { getBlueprintForWorkspace } = await import("@/ipc/handlers/blueprint_handlers");
    const blueprint = await getBlueprintForWorkspace(workspaceId, {
      focusPath: ".",
      allowWorkspaceRoot: true,
    });
    const graph = blueprintToRagGraph(blueprint, workspaceRootAbs);
    if (graph.nodes.length === 0) return null;

    engine.defineConfig({
      // Same Tier-1 intent: lean on the room name over its snippet.
      fldWeights: { name: 4, description: 2, path: 1, snippet: 1.5 },
    });

    const emptyRanges = new Map();
    for (const node of graph.nodes) {
      if (!node.file?.trim()) continue;
      const sn = await getCodeSnippetForBuildNode(graph, node.id, workspaceRootAbs, emptyRanges);
      const relFile = sn?.path ?? node.file;
      const absFile = path.isAbsolute(relFile)
        ? relFile
        : path.join(workspaceRootAbs, relFile);
      const snippet = (sn?.content ?? node.description ?? "").slice(0, 4000);
      const line = sn?.line ?? 1;
      engine.addDoc(
        {
          name: node.name ?? "",
          description: (node.description ?? "").slice(0, 2000),
          path: [node.path, node.file].filter(Boolean).join(" "),
          snippet,
        },
        docId,
      );
      meta.push({ absFile, line });
      docTexts.push(`${node.name ?? ""} ${node.description ?? ""} ${snippet}`);
      filesSeen.add(absFile);
      docId += 1;
    }
  }

  if (docId === 0) return null;
  engine.consolidate();

  // Optional Model2Vec embedding lane (semanticRecall): embed each doc once at
  // build time so queries can fuse a semantic ranking with BM25. Gated + lazy —
  // a no-op (and zero added latency) when the setting is off.
  let docVectors: Float32Array | null = null;
  let embDim = 0;
  if (ensureSemanticModel()) {
    const first = embedQuery(docTexts[0] ?? "");
    if (first) {
      embDim = first.length;
      docVectors = new Float32Array(docTexts.length * embDim);
      docVectors.set(first, 0);
      for (let i = 1; i < docTexts.length; i++) {
        const v = embedQuery(docTexts[i] ?? "");
        if (v) docVectors.set(v, i * embDim); // else leaves a zero vector
      }
      logger.info(`bm25 buildIndex: embedded ${docTexts.length} docs (${embDim}d)`);
    }
  }

  let commitHash: string | null = null;
  try {
    commitHash = await getCurrentCommitHash({ path: workspaceRootAbs });
  } catch {
    commitHash = null;
  }
  const elapsedMs = Date.now() - t0;
  logger.info("bm25 buildIndex: complete", {
    workspaceId,
    elapsedMs,
    docs: docId,
    filesIndexed: filesSeen.size,
    graphNodes: symbolDocs.length || docId,
    commitHash: commitHash ?? "none",
  });
  void import("@sentry/electron/main")
    .then((Sentry) => {
      Sentry.addBreadcrumb({
        category: "bm25",
        message: "build_complete",
        level: "info",
        data: { workspaceId, elapsedMs, docs: docId },
      });
    })
    .catch(() => {});
  return { engine, meta, filesIndexed: filesSeen.size, commitHash, docVectors, embDim };
}

export type Bm25SearchResult = {
  hits: Bm25BeaconHit[];
  totalMatches: number;
  filesIndexed: number;
};

/** Get the warm index for a workspace, (re)building if dirty or stale. */
async function getCachedBlueprintIndex(
  workspaceId: number,
  workspaceRootAbs: string,
): Promise<CachedIndex | null> {
  const dirty = bm25DirtyByWorkspaceId.has(workspaceId);
  let cached: CachedIndex | undefined = dirty ? undefined : indexByWorkspaceId.get(workspaceId);
  if (cached) {
    let head: string | null = null;
    try {
      head = await getCurrentCommitHash({ path: workspaceRootAbs });
    } catch {
      head = null;
    }
    if (cached.commitHash !== undefined && head !== cached.commitHash) {
      indexByWorkspaceId.delete(workspaceId);
      cached = undefined;
    }
  }
  if (!cached) {
    let built: CachedIndex | null;
    try {
      built = await buildIndex(workspaceId, workspaceRootAbs);
    } catch (e) {
      logger.warn("BM25 index build failed:", e);
      return null;
    }
    if (!built) return null;
    cached = built;
    indexByWorkspaceId.set(workspaceId, cached);
    bm25DirtyByWorkspaceId.delete(workspaceId);
  }
  return cached;
}

/**
 * Optional Model2Vec semantic ranking (semanticRecall): returns files ranked by
 * the best cosine similarity of any of their docs to the query. Null when the
 * embedding lane is off / unavailable — callers then use BM25 alone.
 */
export async function searchBlueprintByEmbedding(
  workspaceId: number,
  workspaceRootAbs: string,
  query: string,
  maxResults: number,
): Promise<string[] | null> {
  if (!ensureSemanticModel()) return null;
  const cached = await getCachedBlueprintIndex(workspaceId, workspaceRootAbs);
  if (!cached?.docVectors || !cached.embDim) return null;
  const qv = embedQuery(query.trim());
  if (!qv || qv.length !== cached.embDim) return null;

  const { docVectors, embDim, meta } = cached;
  const nDocs = meta.length;
  // Best per-file similarity (a file has many symbol docs).
  const fileBest = new Map<string, number>();
  for (let i = 0; i < nDocs; i++) {
    const v = docVectors.subarray(i * embDim, i * embDim + embDim);
    const sim = cosineSim(qv, v);
    const f = meta[i]?.absFile;
    if (!f) continue;
    const prev = fileBest.get(f);
    if (prev === undefined || sim > prev) fileBest.set(f, sim);
  }
  return [...fileBest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([f]) => f);
}

export async function searchBlueprintBm25(
  workspaceId: number,
  workspaceRootAbs: string,
  query: string,
  maxResults: number,
): Promise<Bm25SearchResult | null> {
  const cached = await getCachedBlueprintIndex(workspaceId, workspaceRootAbs);
  if (!cached) return null;

  const scanLimit = Math.max(maxResults, 200);
  let raw: Array<[number, number]>;
  try {
    raw = cached.engine.search(query.trim(), scanLimit);
  } catch (e) {
    logger.warn("BM25 search failed:", e);
    return null;
  }

  if (!raw.length) {
    return { hits: [], totalMatches: 0, filesIndexed: cached.filesIndexed };
  }

  const hits: Bm25BeaconHit[] = [];
  for (const [id, score] of raw) {
    if (hits.length >= maxResults) break;
    const m = cached.meta[id];
    if (!m) continue;
    const ctx = await enrichLineContext(m.absFile, m.line);
    hits.push({
      score,
      file: m.absFile,
      line: m.line,
      ...ctx,
    });
  }

  return {
    hits,
    totalMatches: raw.length,
    filesIndexed: cached.filesIndexed,
  };
}
