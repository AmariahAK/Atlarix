/**
 * Load tree-sitter grammars (main process only). Uses createRequire for native .node bindings.
 */

import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

export type GrammarKey = "typescript" | "tsx" | "javascript" | "python";

let tsBundle: { typescript: unknown; tsx: unknown } | null = null;
let javascriptGrammar: unknown | null = null;
let pythonGrammar: unknown | null = null;

function loadTsBundle(): { typescript: unknown; tsx: unknown } | null {
  if (tsBundle) return tsBundle;
  try {
    tsBundle = require("tree-sitter-typescript") as { typescript: unknown; tsx: unknown };
    return tsBundle;
  } catch {
    return null;
  }
}

export function getLanguageForGrammar(key: GrammarKey): unknown | null {
  try {
    switch (key) {
      case "typescript": {
        const b = loadTsBundle();
        return b?.typescript ?? null;
      }
      case "tsx": {
        const b = loadTsBundle();
        return b?.tsx ?? null;
      }
      case "javascript": {
        if (javascriptGrammar == null) {
          javascriptGrammar = require("tree-sitter-javascript");
        }
        return javascriptGrammar;
      }
      case "python": {
        if (pythonGrammar == null) {
          pythonGrammar = require("tree-sitter-python");
        }
        return pythonGrammar;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Pick grammar from file path extension (TS/TSX/JS/JSX/Python). */
export function grammarKeyFromFilePath(filePath: string): GrammarKey | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsx") return "tsx";
  if (ext === ".ts") return "typescript";
  if (ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".js") return "javascript";
  if (ext === ".py" || ext === ".pyi") return "python";
  return null;
}
