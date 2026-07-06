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
import type { SymbolRecord } from "@/lib/index/symbol-types";
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

/** Most common ctags-reported language across the symbol set (lowercased), or null. */
function dominantLanguageFromSymbols(symbols: SymbolRecord[]): string | null {
  const counts = new Map<string, number>();
  for (const s of symbols) {
    if (!s.language) continue;
    counts.set(s.language, (counts.get(s.language) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
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
 *
 * Language detection is a framework HINT, never a gate: an unrecognized
 * project still gets a ctags-backed blueprint (ctags auto-detects languages),
 * with the dominant symbol language as the label. The signature keeps
 * `| null` for caller compatibility, but null is no longer returned.
 */
export async function generateBlueprint(projectPath: string): Promise<RTEParseResult | null> {
  // Composed source = built-in baseline ∪ project .gitignore ∪ .atlarixignore.
  // Stored on the result as the cache key so a change to any layer re-indexes.
  const ignoreSourceForCache = await composeIgnoreSource(projectPath);
  const ig = createIgnorerFromSource(ignoreSourceForCache);

  const detected = await detectLanguage(projectPath);

  try {
    const symbolIndex = await ensureSymbolIndex(projectPath);
    const frameworkName =
      detected ?? dominantLanguageFromSymbols(symbolIndex.symbols) ?? "unknown";
    const framework = { name: frameworkName, confidence: detected ? 0.85 : 0.5 };
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
      framework: { name: detected ?? "unknown", confidence: 0.5 },
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
): "ast-grep+ctags" | "ctags-only" | "file-tree" | "hybrid" {
  if (!result?.nodes?.length) return "file-tree";
  if (options?.supplemented) return "hybrid";
  // ctags-only: real parse-derived symbol nodes exist but the language has no
  // ast-grep grammar (structural edges are progressive enhancement).
  return result.edges.length > 0 ? "ast-grep+ctags" : "ctags-only";
}
