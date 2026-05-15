/**
 * PASS6: tree-sitter Python parser unavailable; the RTE Python regex parser
 * (`src/lib/blueprint/rte/parsers/python.ts`) handles extraction.
 */

import type { ParsedFileResult } from "@/lib/analysis/parsed-file-result";
import type { SyntaxNodeStub, TreeStub } from "./tree-sitter-parser";
import type { BlueprintNode } from "@/lib/blueprint/rte/parsers/types";

function emptyParsed(): ParsedFileResult {
  return {
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    functionCalls: [],
    classInstantiations: [],
  };
}

export function extractParsedFileResultFromPythonRoot(
  _root: SyntaxNodeStub,
  _content: string,
): ParsedFileResult {
  return emptyParsed();
}

export function extractParsedFileResultFromPythonTree(
  _tree: TreeStub,
  _content: string,
): ParsedFileResult {
  return emptyParsed();
}

export function extractBlueprintNodesFromPython(
  _content: string,
  _tree: TreeStub,
  _relPath: string,
  _startIndex: number,
): BlueprintNode[] {
  return [];
}
