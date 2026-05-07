/**
 * RTE parser registry and generateBlueprint
 * Detects language from project root, selects parser, parses files, returns nodes + edges + framework.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type {
  LanguageParser,
  RTEParseResult,
  SupportedLanguage,
  BlueprintNode,
  RTEBlueprintEdge,
} from "./types";
import { typeScriptParser } from "./typescript";
import { pythonParser } from "./python";
import { javaParser } from "./java";
import { kotlinParser } from "./kotlin";
import { goParser } from "./go";
import { rustParser } from "./rust";
import { csharpParser } from "./csharp";
import { rubyParser } from "./ruby";
import { phpParser } from "./php";
import { swiftParser } from "./swift";
import { elixirParser } from "./elixir";
import { extractImportAndCallEdges } from "./edgeExtractor";
import { getSimpleDescriptionFromDoc } from "@/lib/blueprint/descriptions/jsdocExtractor";
import { getSimpleDescriptionFromPattern } from "@/lib/blueprint/descriptions/patternMatcher";
import {
  ensureDefaultAtlarixIgnore,
  readAtlarixIgnoreSource,
  createIgnorerFromSource,
  DEFAULT_ATLARIXIGNORE,
  filterRteNodesByIgnore,
  filterRteEdgesByNodes,
} from "@/lib/atlarix/atlarix-ignore";
import { getProjectFiles } from "@/ipc/utils/project-files";
import { isExcludedDir } from "@/ipc/utils/file_utils";

export type { BlueprintNode, RTEBlueprintEdge, RTEParseResult, FrameworkInfo, SupportedLanguage } from "./types";

/** Map runtime/indicator to parser language key */
async function detectLanguage(projectPath: string): Promise<SupportedLanguage | null> {
  let names: string[] = [];
  try {
    names = await fs.readdir(projectPath);
  } catch {
    return null;
  }
  if (names.includes("package.json") || names.includes("bun.lockb") || names.includes("deno.json") || names.includes("deno.jsonc")) {
    return "typescript"; // use TypeScript parser for node/bun/deno (handles .js/.ts)
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

const CODE_EXTENSIONS: Record<SupportedLanguage, string[]> = {
  typescript: [".ts", ".tsx", ".js", ".jsx"],
  javascript: [".js", ".jsx", ".ts", ".tsx"],
  python: [".py"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
  csharp: [".cs"],
  ruby: [".rb"],
  php: [".php"],
  swift: [".swift"],
  kotlin: [".kt", ".kts"],
  elixir: [".ex", ".exs"],
};

/** Collect source file paths under projectPath for the given language */
async function getSourceFiles(projectPath: string, language: SupportedLanguage): Promise<string[]> {
  const ext = CODE_EXTENSIONS[language] ?? [];
  const { files } = await getProjectFiles(projectPath);
  const relFiles = files.map((f) => path.relative(projectPath, f));
  return relFiles.filter((f) => {
    const extLower = f.toLowerCase();
    return ext.some((e) => extLower.endsWith(e));
  });
}

/** Registry of language parsers. Only typescript and python are implemented; others return empty. */
export const PARSERS: Partial<Record<SupportedLanguage, LanguageParser>> = {
  typescript: typeScriptParser,
  javascript: typeScriptParser,
  python: pythonParser,
  java: javaParser,
  kotlin: kotlinParser,
  go: goParser,
  rust: rustParser,
  csharp: csharpParser,
  ruby: rubyParser,
  php: phpParser,
  swift: swiftParser,
  elixir: elixirParser,
};

/**
 * Generate full Blueprint (nodes + edges + framework) for a project using RTE parsers.
 * Detects language, collects source files, runs parser, returns result.
 */
export async function generateBlueprint(projectPath: string): Promise<RTEParseResult | null> {
  await ensureDefaultAtlarixIgnore(projectPath);
  const ignoreRaw = await readAtlarixIgnoreSource(projectPath);
  const ignoreSourceForCache = ignoreRaw.trim() ? ignoreRaw : DEFAULT_ATLARIXIGNORE;
  const ig = createIgnorerFromSource(ignoreSourceForCache);

  const language = await detectLanguage(projectPath);
  if (!language) return null;

  const parser = PARSERS[language];
  if (!parser) {
    return {
      nodes: [],
      edges: [],
      framework: { name: language, confidence: 0 },
      atlarixIgnoreSource: ignoreSourceForCache,
    };
  }

  let files = await getSourceFiles(projectPath, language);
  files = files.filter((rel) => !ig.ignores(rel.replace(/\\/g, "/")));
  if (files.length === 0) {
    const framework = await parser.detectFramework([]);
    return {
      nodes: [],
      edges: [],
      framework,
      atlarixIgnoreSource: ignoreSourceForCache,
    };
  }

  const absolutePaths = files.map((f) => path.join(projectPath, f));
  let nodes = await parser.parse(absolutePaths);
  const framework = await parser.detectFramework(absolutePaths);

  await enrichNodesWithDescriptions(projectPath, nodes, language);

  nodes = filterRteNodesByIgnore(nodes, ig, projectPath);
  const kept = new Set(nodes.map((n) => n.id));
  const callEdges = filterRteEdgesByNodes(extractEdgesFromNodes(nodes), kept);
  const importEdges = filterRteEdgesByNodes(
    await extractImportAndCallEdges(projectPath, nodes, language),
    kept,
  );
  const edges = [...callEdges, ...importEdges];

  return { nodes, edges, framework, atlarixIgnoreSource: ignoreSourceForCache };
}

const DOC_LANG: Record<SupportedLanguage, "ts" | "py"> = {
  typescript: "ts",
  javascript: "ts",
  python: "py",
  go: "ts",
  rust: "ts",
  java: "ts",
  csharp: "ts",
  ruby: "ts",
  php: "ts",
  swift: "ts",
  kotlin: "ts",
  elixir: "ts",
};

async function enrichNodesWithDescriptions(
  projectPath: string,
  nodes: BlueprintNode[],
  language: SupportedLanguage
): Promise<void> {
  const docLang = DOC_LANG[language] ?? "ts";
  const byFile = new Map<string, BlueprintNode[]>();
  for (const n of nodes) {
    const f = n.file.replace(/\\/g, "/");
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f)!.push(n);
  }
  const kindMap = (k: string): "api" | "webhook" | "function" | "feature" | "class" =>
    k === "api" ? "api" : k === "webhook" ? "webhook" : k === "class" ? "class" : "function";
  for (const [relPath, fileNodes] of byFile) {
    const absPath = path.join(projectPath, relPath);
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch {
      continue;
    }
    for (const node of fileNodes) {
      const line = node.line ?? 1;
      const fromDoc = getSimpleDescriptionFromDoc(content, line, docLang);
      if (fromDoc) {
        node.simpleDescription = fromDoc.trim().slice(0, 120);
        node.descriptionSource = "jsdoc";
        continue;
      }
      const fromPattern = getSimpleDescriptionFromPattern(
        node.name,
        kindMap(node.type),
        node.path ?? node.file
      );
      if (fromPattern) {
        node.simpleDescription = fromPattern;
        node.descriptionSource = "pattern";
      }
    }
  }
}

function extractEdgesFromNodes(nodes: BlueprintNode[]): RTEBlueprintEdge[] {
  const edges: RTEBlueprintEdge[] = [];
  const idSet = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    for (const toId of node.calls ?? []) {
      if (idSet.has(toId)) {
        edges.push({ from: node.id, to: toId, type: "calls" });
      }
    }
  }
  return edges;
}
