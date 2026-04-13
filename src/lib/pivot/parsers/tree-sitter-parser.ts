/**
 * Small tree-sitter AST helpers shared by workspace and RTE extractors.
 */

import type Parser from "tree-sitter";

export function walkNamed(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  const n = node.namedChildCount;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild(i);
    if (c) walkNamed(c, visit);
  }
}

export function lineOfIndex(content: string, index: number): number {
  return (content.slice(0, index).match(/\n/g) || []).length + 1;
}
