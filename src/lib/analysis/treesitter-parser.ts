/**
 * Tree-sitter integration for workspace analysis (Pivot path).
 * Delegates to pivot/parser extractors; falls back to regex when this returns null.
 */

import Parser from "tree-sitter";
import type { ParsedFileResult } from "./parsed-file-result";
export type { ParsedFileResult } from "./parsed-file-result";
import {
  getLanguageForGrammar,
  grammarKeyFromFilePath,
  type GrammarKey,
} from "@/lib/pivot/parsers/grammar-loader";
import { extractParsedFileResultFromTsRoot } from "@/lib/pivot/parsers/typescript-ts-parser";
import { extractParsedFileResultFromPythonRoot } from "@/lib/pivot/parsers/python-ts-parser";
import {
  getCachedTree,
  setCachedTree,
  makeParseCacheKey,
} from "@/lib/pivot/parsers/parse-tree-cache";

let smokeTestResult: boolean | null = null;

function parseToTree(
  content: string,
  grammarKey: GrammarKey,
  cacheKey?: string,
): Parser.Tree | null {
  const lang = getLanguageForGrammar(grammarKey);
  if (!lang) return null;
  const parser = new Parser();
  try {
    parser.setLanguage(lang as unknown as Parameters<Parser["setLanguage"]>[0]);
  } catch {
    return null;
  }
  try {
    let tree: Parser.Tree;
    if (cacheKey) {
      const old = getCachedTree(cacheKey);
      if (old) {
        try {
          tree = parser.parse(content, old);
        } catch {
          tree = parser.parse(content);
        }
      } else {
        tree = parser.parse(content);
      }
      setCachedTree(cacheKey, tree);
    } else {
      tree = parser.parse(content);
    }
    return tree;
  } catch {
    return null;
  }
}

/**
 * Parse file with tree-sitter; returns null on unsupported language / load failure (regex fallback).
 */
export async function parseWithTreeSitter(
  content: string,
  language: string,
  filePath = "",
  options?: { workspacePath?: string; relativePath?: string },
): Promise<ParsedFileResult | null> {
  const gk = grammarKeyFromFilePath(filePath);
  if (!gk) return null;
  if (language === "python" && gk !== "python") return null;
  if (gk !== "python" && language === "python") return null;

  const cacheKey =
    options?.workspacePath && options?.relativePath
      ? makeParseCacheKey(options.workspacePath, options.relativePath)
      : undefined;

  try {
    if (gk === "python") {
      const tree = parseToTree(content, "python", cacheKey);
      if (!tree) return null;
      return extractParsedFileResultFromPythonRoot(tree.rootNode, content);
    }
    const tree = parseToTree(content, gk, cacheKey);
    if (!tree) return null;
    return extractParsedFileResultFromTsRoot(tree.rootNode);
  } catch {
    return null;
  }
}

/** True after a minimal TypeScript parse succeeds (native bindings + grammar load). */
export async function isTreeSitterAvailable(): Promise<boolean> {
  if (smokeTestResult !== null) return smokeTestResult;
  try {
    const lang = getLanguageForGrammar("typescript");
    if (!lang) {
      smokeTestResult = false;
      return false;
    }
    const parser = new Parser();
    parser.setLanguage(lang as unknown as Parameters<Parser["setLanguage"]>[0]);
    const tree = parser.parse("const __smoke = 1;");
    smokeTestResult = tree.rootNode.namedChildCount > 0;
    return smokeTestResult;
  } catch {
    smokeTestResult = false;
    return false;
  }
}
