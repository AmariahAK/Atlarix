/**
 * Incremental blueprint cache refresh for a single changed file.
 * Updates ctags symbols + ast-grep edges without a full-project scan.
 */

import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";
import { loadBlueprintCache, saveBlueprintCache } from "@/lib/cache/blueprint-cache";
import { blueprintEngineLabel } from "@/lib/blueprint/rte/parsers";
import type { BlueprintNode, RTEBlueprintEdge } from "@/lib/blueprint/rte/parsers/types";
import { scanFileStructuralEdges } from "@/lib/blueprint/rte/ast-grep/scan-file-edges";
import { buildSymbolLookup } from "@/lib/blueprint/rte/ast-grep/scan-file-edges";
import { ctagsKindToNodeType } from "@/lib/index/ctags-parse";
import {
  getSymbolsForFile,
  updateSymbolIndexForFile,
} from "@/lib/index/ctags-index";
import type { SymbolRecord } from "@/lib/index/symbol-types";
import { generateBlueprint } from "@/lib/blueprint/rte/parsers";

const logger = log.scope("blueprint:incremental");

function normalizeRelPath(relFile: string): string {
  return relFile.replace(/\\/g, "/").replace(/^\//, "");
}

function symbolsToNodes(symbols: SymbolRecord[]): BlueprintNode[] {
  return symbols.map((s) => ({
    id: s.id,
    type: ctagsKindToNodeType(s.kind),
    name: s.name,
    file: s.path.replace(/\\/g, "/"),
    line: s.line,
    description: s.signature ?? s.scope,
    simpleDescription: s.signature,
    descriptionSource: "pattern" as const,
  }));
}

function dedupeEdges(edges: RTEBlueprintEdge[]): RTEBlueprintEdge[] {
  const seen = new Set<string>();
  const out: RTEBlueprintEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}->${e.to}:${e.type ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

async function fileExists(projectPath: string, relFile: string): Promise<boolean> {
  try {
    await fs.access(path.join(projectPath, relFile));
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge updated symbols + structural edges for one file into the RTE blueprint cache.
 * Falls back to full generateBlueprint when no cache exists.
 */
export async function updateBlueprintCacheForFile(
  projectPath: string,
  relFile: string,
): Promise<boolean> {
  const normRel = normalizeRelPath(relFile);
  const normPath = path.resolve(projectPath);

  const cached = await loadBlueprintCache(normPath);
  if (!cached?.nodes?.length) {
    logger.debug("updateBlueprintCacheForFile: no cache, full rebuild", { normRel });
    const result = await generateBlueprint(normPath);
    if (!result) return false;
    await saveBlueprintCache(normPath, {
      manifest: {
        projectPath: normPath,
        framework: result.framework.name,
        language: result.framework.name,
        engine: blueprintEngineLabel(result),
      },
      nodes: result.nodes,
      edges: result.edges,
      ...(result.atlarixIgnoreSource ? { atlarixIgnoreSource: result.atlarixIgnoreSource } : {}),
    });
    return true;
  }

  const symbolCache = await updateSymbolIndexForFile(normPath, normRel);
  const exists = await fileExists(normPath, normRel);

  const removedNodeIds = new Set(
    cached.nodes
      .filter((n) => normalizeRelPath(n.file) === normRel)
      .map((n) => n.id),
  );

  let nodes = cached.nodes.filter((n) => !removedNodeIds.has(n.id));
  let edges = cached.edges.filter((e) => !removedNodeIds.has(e.from) && !removedNodeIds.has(e.to));

  if (exists) {
    const fileSymbols = getSymbolsForFile(symbolCache, normRel);
    const byFile = buildSymbolLookup(symbolCache.symbols);
    // v12 S20: scanFileStructuralEdges returns {edges, dynamicCalls}; the
    // incremental path keeps the manifest's whole-scan count as-is (a single
    // file's delta isn't worth a manifest rewrite churn).
    const newEdges = (await scanFileStructuralEdges(normPath, normRel, byFile)).edges;
    nodes = [...nodes, ...symbolsToNodes(fileSymbols)];
    edges = dedupeEdges([...edges, ...newEdges]);
  }

  await saveBlueprintCache(normPath, {
    manifest: {
      ...cached.manifest,
      projectPath: normPath,
      engine: cached.manifest.engine ?? "ast-grep+ctags",
    },
    nodes,
    edges,
    ...(cached.atlarixIgnoreSource ? { atlarixIgnoreSource: cached.atlarixIgnoreSource } : {}),
  });

  logger.info("updateBlueprintCacheForFile: complete", {
    projectPath: normPath,
    relFile: normRel,
    nodes: nodes.length,
    edges: edges.length,
    removed: removedNodeIds.size,
  });
  return true;
}

export async function updateBlueprintCacheForFiles(
  projectPath: string,
  relFiles: string[],
): Promise<boolean> {
  const unique = [...new Set(relFiles.map(normalizeRelPath))];
  if (unique.length === 0) return false;
  let ok = false;
  for (const rel of unique) {
    ok = (await updateBlueprintCacheForFile(projectPath, rel)) || ok;
  }
  return ok;
}
