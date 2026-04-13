/**
 * PIVOT parsers — unified parseProject(workspacePath) using workspace-analyzer + structure extractor.
 * Workspace analysis uses tree-sitter when native grammars load, with regex fallback.
 */

import { analyzeWorkspace } from "@/lib/analysis";
import { extractStructure } from "../structure";
import type { ParsedProject } from "../types";
import log from "electron-log";

const logger = log.scope("pivot-parsers");

/**
 * Parse a project at workspacePath into nodes and edges.
 * Uses existing workspace-analyzer (regex + optional Tree-sitter) then structure extractor.
 */
export async function parseProject(workspacePath: string): Promise<ParsedProject> {
  const analysis = await analyzeWorkspace(workspacePath);
  const result = extractStructure(analysis);
  logger.debug("parseProject", {
    workspacePath,
    nodes: result.nodes.length,
    edges: result.edges.length,
    framework: result.framework,
  });
  return result;
}
