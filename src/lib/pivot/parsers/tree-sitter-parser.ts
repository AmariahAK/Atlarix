/**
 * PASS6: tree-sitter native module not installed (removed in Pass 7 dep audit).
 * We keep the public surface (`walkNamed`, `lineOfIndex`) as no-ops/utilities
 * and export local stub types so the rest of the Blueprint code can import them
 * without dragging in the native module.
 */

export interface SyntaxNodeStub {
  type: string;
  text: string;
  namedChildren: SyntaxNodeStub[];
  childForFieldName?: (name: string) => SyntaxNodeStub | null;
}

export interface TreeStub {
  rootNode: SyntaxNodeStub;
}

export function walkNamed(_node: SyntaxNodeStub, _visit: (n: SyntaxNodeStub) => void): void {
  // no-op: real walker requires a tree-sitter Tree, which is unavailable.
}

export function lineOfIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}
