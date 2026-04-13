/**
 * Build a tree-sitter Tree for a source file (no incremental cache — used by RTE per file).
 */

import Parser from "tree-sitter";
import { getLanguageForGrammar, grammarKeyFromFilePath } from "./grammar-loader";

export function parseSourceToTree(content: string, filePath: string): Parser.Tree | null {
  const gk = grammarKeyFromFilePath(filePath);
  if (!gk) return null;
  const lang = getLanguageForGrammar(gk);
  if (!lang) return null;
  const parser = new Parser();
  try {
    parser.setLanguage(lang as unknown as Parameters<Parser["setLanguage"]>[0]);
  } catch {
    return null;
  }
  try {
    return parser.parse(content);
  } catch {
    return null;
  }
}
