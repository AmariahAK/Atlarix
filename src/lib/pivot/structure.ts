/**
 * PIVOT structure extractor — maps workspace analysis to PivotNode[] and PivotEdge[].
 * Consumes output from workspace-analyzer (or future ANTLR4/Tree-sitter parsers).
 */

import * as path from "path";
import type { WorkspaceAnalysis, AnalyzedFile, Dependency } from "@/lib/analysis";
import type { PivotNode, PivotEdge, PivotNodeType, PivotEdgeType, ParsedProject } from "./types";

const SEP = "::";

/** Build a stable external id for a file node. */
function fileNodeId(relativePath: string): string {
  return `file${SEP}${relativePath}`;
}

/** Build a stable external id for a function/class node (scoped to file). */
function symbolNodeId(relativePath: string, type: "function" | "class", name: string): string {
  return `file${SEP}${relativePath}${SEP}${type}${SEP}${name}`;
}

/**
 * Extract PivotNode[] and PivotEdge[] from WorkspaceAnalysis.
 * - File nodes: one per analyzed file.
 * - Symbol nodes: one per function/class (type function | class).
 * - Edges: import (file→file), and optional call/extends from dependencies.
 */
export function extractStructure(analysis: WorkspaceAnalysis): ParsedProject {
  const nodes: PivotNode[] = [];
  const edges: PivotEdge[] = [];
  const fileIds = new Map<string, string>();

  for (const file of analysis.files) {
    const rel = file.relativePath;
    const fileId = fileNodeId(rel);
    fileIds.set(rel, fileId);
    nodes.push({
      id: fileId,
      type: "file",
      label: path.basename(rel, path.extname(rel)),
      filePath: file.path,
      metadata: { relativePath: rel, language: file.language, fileType: file.type },
    });

    for (const name of file.functions) {
      const symId = symbolNodeId(rel, "function", name);
      nodes.push({
        id: symId,
        type: "function",
        label: name,
        filePath: file.path,
        metadata: { relativePath: rel, parentFileId: fileId },
      });
    }
    for (const name of file.classes) {
      const symId = symbolNodeId(rel, "class", name);
      nodes.push({
        id: symId,
        type: "class",
        label: name,
        filePath: file.path,
        metadata: { relativePath: rel, parentFileId: fileId },
      });
    }
  }

  const edgeKeys = new Set<string>();
  for (const dep of analysis.dependencies) {
    const fromId = fileIds.get(dep.from);
    const toId = fileIds.get(dep.to);
    if (fromId && toId && fromId !== toId) {
      const key = `${fromId}\t${toId}\t${dep.type}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        id: `edge_${fromId}_${toId}_${dep.type}`,
        fromId,
        toId,
        type: dep.type as PivotEdgeType,
        metadata: {},
      });
    }
  }

  return {
    nodes,
    edges,
    framework: analysis.framework,
    language: analysis.language,
  };
}
