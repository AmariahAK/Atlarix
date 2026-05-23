/**
 * Blast-radius analysis using Blueprint flow edges + ctags symbol index.
 * Used before file edits (permission metadata) and diagnose change_impact.
 */

import * as path from "path";
import type { Blueprint } from "@/shared/blueprint-types";
import { loadBlueprintCache } from "@/lib/cache/blueprint-cache";
import { rteResultToBlueprint } from "@/lib/blueprint/rte_to_blueprint";
import {
  ensureSymbolIndex,
  findSymbolsByName,
  getSymbolsForFile,
} from "@/lib/index/ctags-index";
import { bfsSymbolGraph, type SymbolEdge } from "@/lib/blueprint/rte/ast-grep/graph-bfs";
import { ensureBlueprintParsed } from "@/lib/blueprint/lazy-parse";

export type BlastRadiusImpactLevel = "low" | "medium" | "high";

export type BlastRadiusAffectedSymbol = {
  id: string;
  name: string;
  file: string;
  line?: number;
  kind?: string;
  relation: "target" | "caller" | "callee" | "importer" | "imported";
};

export type BlastRadiusResult = {
  filepath: string;
  impactLevel: BlastRadiusImpactLevel;
  summary: string;
  affectedSymbols: BlastRadiusAffectedSymbol[];
  affectedFiles: string[];
  callerCount: number;
  calleeCount: number;
  importerCount: number;
  edges: SymbolEdge[];
};

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_NODES = 80;

function normalizeRelPath(filepath: string, projectPath: string): string {
  const norm = filepath.replace(/\\/g, "/").replace(/^\//, "");
  const root = projectPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (path.isAbsolute(filepath)) {
    const rel = path.relative(root, filepath).replace(/\\/g, "/");
    return rel.replace(/^\//, "");
  }
  return norm;
}

function impactLevelFromCounts(counts: {
  callers: number;
  callees: number;
  importers: number;
}): BlastRadiusImpactLevel {
  const total = counts.callers + counts.importers;
  if (total >= 15) return "high";
  if (total >= 5) return "medium";
  return "low";
}

function collectSymbolEdges(blueprint: Blueprint): SymbolEdge[] {
  const edges: SymbolEdge[] = [];
  const seen = new Set<string>();
  for (const room of blueprint.rooms) {
    for (const fe of room.flowEdges ?? []) {
      const key = `${fe.from}->${fe.to}:${fe.type ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: fe.from,
        to: fe.to,
        type: fe.type,
        label: fe.label,
      });
    }
  }
  return edges;
}

async function loadBlueprintForAnalysis(
  projectPath: string,
  workspaceId?: number,
): Promise<Blueprint | null> {
  if (workspaceId != null) {
    try {
      return await ensureBlueprintParsed(workspaceId);
    } catch {
      /* fall through */
    }
  }

  const cached = await loadBlueprintCache(projectPath);
  if (cached?.nodes?.length) {
    return rteResultToBlueprint(
      { nodes: cached.nodes, edges: cached.edges, framework: { name: cached.manifest.language, confidence: 1 } },
      projectPath,
    );
  }
  if (cached?.blueprint?.rooms?.length) {
    return cached.blueprint;
  }
  return null;
}

export async function analyzeBlastRadius(args: {
  projectPath: string;
  filepath: string;
  workspaceId?: number;
  maxDepth?: number;
  maxNodes?: number;
}): Promise<BlastRadiusResult> {
  const projectPath = path.resolve(args.projectPath);
  const relFile = normalizeRelPath(args.filepath, projectPath);
  const maxDepth = args.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = args.maxNodes ?? DEFAULT_MAX_NODES;

  const symbolIndex = await ensureSymbolIndex(projectPath);
  const fileSymbols = getSymbolsForFile(symbolIndex, relFile);
  const baseName = path.basename(relFile, path.extname(relFile));
  const nameHits = findSymbolsByName(symbolIndex, baseName, { limit: 20 }).filter(
    (s) => s.path.replace(/\\/g, "/") === relFile,
  );

  const startIds = [...new Set([...fileSymbols, ...nameHits].map((s) => s.id))];
  const blueprint = await loadBlueprintForAnalysis(projectPath, args.workspaceId);
  const symbolEdges = blueprint ? collectSymbolEdges(blueprint) : [];

  const affectedSymbols: BlastRadiusAffectedSymbol[] = [];
  const affectedFiles = new Set<string>([relFile]);
  const resultEdges: SymbolEdge[] = [];

  for (const s of fileSymbols.length ? fileSymbols : nameHits) {
    affectedSymbols.push({
      id: s.id,
      name: s.name,
      file: s.path,
      line: s.line,
      kind: s.kind,
      relation: "target",
    });
  }

  if (startIds.length === 0 || symbolEdges.length === 0) {
    const level: BlastRadiusImpactLevel = "low";
    return {
      filepath: relFile,
      impactLevel: level,
      summary:
        startIds.length === 0
          ? `No indexed symbols in \`${relFile}\`; blast radius unknown (ctags may be warming).`
          : `No Blueprint flow edges yet for \`${relFile}\`; run get_blueprint or refresh-from-code for graph-backed impact.`,
      affectedSymbols,
      affectedFiles: [...affectedFiles],
      callerCount: 0,
      calleeCount: 0,
      importerCount: 0,
      edges: [],
    };
  }

  const callers = bfsSymbolGraph(startIds, symbolEdges, {
    direction: "reverse",
    edgeTypes: new Set(["call", "calls", "api"]),
    maxDepth,
    maxNodes,
  });
  const importers = bfsSymbolGraph(startIds, symbolEdges, {
    direction: "reverse",
    edgeTypes: new Set(["import", "imports"]),
    maxDepth,
    maxNodes,
  });
  const callees = bfsSymbolGraph(startIds, symbolEdges, {
    direction: "forward",
    edgeTypes: new Set(["call", "calls", "api"]),
    maxDepth,
    maxNodes,
  });

  const addFromBfs = (
    bfs: ReturnType<typeof bfsSymbolGraph>,
    relation: BlastRadiusAffectedSymbol["relation"],
  ) => {
    for (const e of bfs.edges) resultEdges.push(e);
    for (const id of bfs.nodes) {
      if (startIds.includes(id)) continue;
      const sym = symbolIndex.symbols.find((s) => s.id === id);
      if (!sym) continue;
      affectedFiles.add(sym.path.replace(/\\/g, "/"));
      if (!affectedSymbols.some((a) => a.id === id)) {
        affectedSymbols.push({
          id: sym.id,
          name: sym.name,
          file: sym.path,
          line: sym.line,
          kind: sym.kind,
          relation,
        });
      }
    }
  };

  addFromBfs(callers, "caller");
  addFromBfs(importers, "importer");
  addFromBfs(callees, "callee");

  const callerCount = affectedSymbols.filter((s) => s.relation === "caller").length;
  const importerCount = affectedSymbols.filter((s) => s.relation === "importer").length;
  const calleeCount = affectedSymbols.filter((s) => s.relation === "callee").length;
  const impactLevel = impactLevelFromCounts({
    callers: callerCount,
    importers: importerCount,
    callees: calleeCount,
  });

  const summary =
    callerCount + importerCount + calleeCount === 0
      ? `Editing \`${relFile}\` has no detected Blueprint dependents within depth ${maxDepth}.`
      : `Editing \`${relFile}\` may affect ${callerCount} caller(s), ${importerCount} importer(s), and ${calleeCount} downstream callee(s) across ${affectedFiles.size} file(s) (impact: ${impactLevel}).`;

  return {
    filepath: relFile,
    impactLevel,
    summary,
    affectedSymbols: affectedSymbols.slice(0, maxNodes),
    affectedFiles: [...affectedFiles].slice(0, maxNodes),
    callerCount,
    calleeCount,
    importerCount,
    edges: resultEdges.slice(0, maxNodes * 2),
  };
}

export function blastRadiusToPermissionMetadata(result: BlastRadiusResult): {
  estimatedImpact: string;
  affectedFiles: string[];
} {
  return {
    estimatedImpact: result.summary,
    affectedFiles: result.affectedFiles.filter((f) => f !== result.filepath),
  };
}
