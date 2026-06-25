/**
 * RTE parser registry and generateBlueprint.
 * Primary: ast-grep (structural) + Universal Ctags (symbol index).
 * Fallback: file-tree bridge when ctags/ast-grep unavailable.
 */

import * as fs from "fs/promises";
import log from "electron-log";
import type { RTEParseResult, SupportedLanguage } from "./types";
import {
  composeIgnoreSource,
  createIgnorerFromSource,
  filterRteNodesByIgnore,
  filterRteEdgesByNodes,
} from "@/lib/atlarix/atlarix-ignore";
import { generateBlueprintFromFileTree } from "@/lib/blueprint/rte/file-tree-bridge";
import { supplementThinRteResult } from "@/lib/blueprint/rte-supplement";
import { getProjectFiles } from "@/ipc/utils/project-files";
import { ensureSymbolIndex } from "@/lib/index/ctags-index";
import { runStructuralScan } from "@/lib/blueprint/rte/ast-grep/run-structural-scan";

const logger = log.scope("rte:generateBlueprint");

export type { BlueprintNode, RTEBlueprintEdge, RTEParseResult, FrameworkInfo, SupportedLanguage } from "./types";

async function detectLanguage(projectPath: string): Promise<SupportedLanguage | null> {
  let names: string[] = [];
  try {
    names = await fs.readdir(projectPath);
  } catch {
    return null;
  }
  if (names.includes("package.json") || names.includes("bun.lockb") || names.includes("deno.json") || names.includes("deno.jsonc")) {
    return "typescript";
  }
  if (names.includes("pyproject.toml") || names.includes("requirements.txt")) return "python";
  if (names.includes("go.mod")) return "go";
  if (names.includes("Cargo.toml")) return "rust";
  if (names.includes("Gemfile")) return "ruby";
  if (names.some((n) => n.endsWith(".csproj")) || names.includes("*.sln")) return "csharp";
  if (names.includes("composer.json")) return "php";
  if (names.includes("mix.exs")) return "elixir";
  if (names.includes("Package.swift")) return "swift";
  if (names.includes("pom.xml") || names.includes("build.gradle")) return "java";
  if (names.includes("build.gradle.kts") || names.includes("settings.gradle.kts")) return "kotlin";
  return null;
}

function dedupeEdges(edges: RTEParseResult["edges"]): RTEParseResult["edges"] {
  const seen = new Set<string>();
  const out: RTEParseResult["edges"] = [];
  for (const e of edges) {
    const key = `${e.from}->${e.to}:${e.type ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Generate Blueprint via ctags symbols + ast-grep structural edges.
 * Falls back to file-tree bridge when indexing fails.
 */
export async function generateBlueprint(projectPath: string): Promise<RTEParseResult | null> {
  // Composed source = built-in baseline ∪ project .gitignore ∪ .atlarixignore.
  // Stored on the result as the cache key so a change to any layer re-indexes.
  const ignoreSourceForCache = await composeIgnoreSource(projectPath);
  const ig = createIgnorerFromSource(ignoreSourceForCache);

  const language = await detectLanguage(projectPath);
  if (!language) return null;

  const framework = { name: language, confidence: 0.85 };

  try {
    const symbolIndex = await ensureSymbolIndex(projectPath);
    const { files } = await getProjectFiles(projectPath);
    const structural = await runStructuralScan(projectPath, files, symbolIndex.symbols);

    let nodes = structural.nodes;
    let edges = structural.edges;

    if (nodes.length === 0) {
      throw new Error("ctags returned no symbols");
    }

    nodes = filterRteNodesByIgnore(nodes, ig, projectPath);
    const kept = new Set(nodes.map((n) => n.id));
    edges = filterRteEdgesByNodes(edges, kept);

    let result: RTEParseResult = {
      nodes,
      edges: dedupeEdges(edges),
      framework,
      atlarixIgnoreSource: ignoreSourceForCache,
      // v12 S20: unresolved (non-identifier-callee) call sites — disclosed
      // through the blueprint manifest so get_blueprint can flag it.
      dynamicCallCount: structural.dynamicCallCount,
    };

    const { result: supplemented, supplemented: didSupplement } = await supplementThinRteResult(
      projectPath,
      result,
      files.length,
    );
    result = { ...supplemented, supplemented: didSupplement };

    logger.info("generateBlueprint: ast-grep+ctags", {
      projectPath,
      nodes: result.nodes.length,
      edges: result.edges.length,
      supplemented: didSupplement,
    });
    return result;
  } catch (err) {
    logger.warn("generateBlueprint: falling back to file-tree", {
      projectPath,
      error: err instanceof Error ? err.message : String(err),
    });

    const result = await generateBlueprintFromFileTree(projectPath, {
      framework: { name: language, confidence: 0.5 },
      atlarixIgnoreSource: ignoreSourceForCache,
    });
    result.nodes = filterRteNodesByIgnore(result.nodes, ig, projectPath);
    return result;
  }
}

/** Engine label persisted in blueprint cache manifest. */
export function blueprintEngineLabel(
  result: RTEParseResult | null,
  options?: { supplemented?: boolean },
): "ast-grep+ctags" | "file-tree" | "hybrid" {
  if (!result?.nodes?.length) return "file-tree";
  if (options?.supplemented) return "hybrid";
  return result.edges.length > 0 ? "ast-grep+ctags" : "file-tree";
}
