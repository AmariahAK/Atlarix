/**
 * Tree-sitter parsing stub (Pass 7.2).
 *
 * Native `tree-sitter*` packages were removed from package.json in Pass 7.
 * This module keeps the public surface (`parseWithTreeSitter`, `isTreeSitterAvailable`)
 * so any residual imports fail softly: callers always see unavailable / null.
 */

import type { ParsedFileResult } from "./parsed-file-result";
export type { ParsedFileResult } from "./parsed-file-result";

export async function parseWithTreeSitter(
  _content: string,
  _language: string,
  _filePath = "",
  _options?: { workspacePath?: string; relativePath?: string },
): Promise<ParsedFileResult | null> {
  return null;
}

export async function isTreeSitterAvailable(): Promise<boolean> {
  return false;
}
