/**
 * PASS6: tree-sitter dependency was removed in Pass 7 and not reinstalled.
 * This file is a no-op stub. The Blueprint regex parsers in
 * `src/lib/blueprint/rte/parsers/{typescript,python}.ts` handle the fallback
 * path when `parseSourceToTree` returns null.
 */

import type { TreeStub as Tree } from "./tree-sitter-parser";

export function parseSourceToTree(_content: string, _filePath: string): Tree | null {
  return null;
}
