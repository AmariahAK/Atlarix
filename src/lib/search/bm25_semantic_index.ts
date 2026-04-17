/**
 * Blueprint-backed BM25 index for semantic_search (beacon nodes + code snippets).
 * Cache is invalidated when blueprint JSON changes (see blueprint_handlers).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import createBm25Engine from "wink-bm25-text-search";
import log from "electron-log";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { blueprintToRagGraph, getCodeSnippetForBuildNode } from "@/lib/blueprint/blueprint-rag";
import { resolveAppPath } from "@/paths/paths";

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
};

const indexByWorkspaceId = new Map<number, CachedIndex>();

export function invalidateBm25Index(workspaceId: number): void {
  indexByWorkspaceId.delete(workspaceId);
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

function tokenizeForBm25(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
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
  const { getBlueprintForWorkspace } = await import("@/ipc/handlers/blueprint_handlers");
  const blueprint = await getBlueprintForWorkspace(workspaceId);
  const graph = blueprintToRagGraph(blueprint, workspaceRootAbs);
  if (graph.nodes.length === 0) return null;

  const engine = createBm25Engine();
  engine.defineConfig({
    fldWeights: { name: 3, description: 2, path: 1, snippet: 2 },
  });
  engine.definePrepTasks([tokenizeForBm25]);

  const meta: NodeMeta[] = [];
  const emptyRanges = new Map();
  let docId = 0;
  const filesSeen = new Set<string>();

  for (const node of graph.nodes) {
    if (!node.file?.trim()) continue;
    const sn = await getCodeSnippetForBuildNode(graph, node.id, workspaceRootAbs, emptyRanges);
    const relFile = sn?.path ?? node.file;
    const absFile = path.isAbsolute(relFile)
      ? relFile
      : path.join(workspaceRootAbs, relFile);
    const snippet = (sn?.content ?? node.description ?? "").slice(0, 4000);
    const line = sn?.line ?? 1;
    const doc = {
      name: node.name ?? "",
      description: (node.description ?? "").slice(0, 2000),
      path: [node.path, node.file].filter(Boolean).join(" "),
      snippet,
    };
    engine.addDoc(doc, docId);
    meta.push({ absFile, line });
    filesSeen.add(absFile);
    docId += 1;
  }

  if (docId === 0) return null;
  engine.consolidate();
  return { engine, meta, filesIndexed: filesSeen.size };
}

export type Bm25SearchResult = {
  hits: Bm25BeaconHit[];
  totalMatches: number;
  filesIndexed: number;
};

export async function searchBlueprintBm25(
  workspaceId: number,
  workspaceRootAbs: string,
  query: string,
  maxResults: number,
): Promise<Bm25SearchResult | null> {
  let cached = indexByWorkspaceId.get(workspaceId);
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
  }

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
