/**
 * PASS6: tree-sitter TS/JS parser unavailable; the RTE TypeScript regex parser
 * (`src/lib/blueprint/rte/parsers/typescript.ts`) handles extraction.
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

export function extractParsedFileResultFromTsRoot(_root: SyntaxNodeStub): ParsedFileResult {
  return emptyParsed();
}

export function extractBlueprintNodesFromTsLike(
  _content: string,
  _tree: TreeStub,
  _relPath: string,
  _startIndex: number,
): BlueprintNode[] {
  return [];
}
