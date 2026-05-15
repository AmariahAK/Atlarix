/**
 * oxc-parser extraction + merge rules for TS/JS/JSX/TSX Blueprint RTE nodes.
 *
 * Merge precedence (documented — do not guess):
 * 1. Primary key: `${relPath}:${kind}:${normalizedName}` where kind ∈ function | class | route | export
 * 2. oxc wins for function | class | export — authoritative spans; regex duplicates dropped
 * 3. regex wins for route (api) and framework decorator routes — oxc does not classify these
 * 4. Same key, different lines: keep both only if |oxcLine - regexLine| > 5 AND regex kind is route
 * 5. Imports: oxc-only (not merged from regex)
 * 6. Tie on route metadata: keep regex
 */

import type { Node, Program, Statement } from "@oxc-project/types";
import { parseInWorker } from "./parser-pool";
import { oxcParseProgram } from "./oxc-parse";
import { walkProgramToNodes } from "./oxc-program-walk";
import type { BlueprintNode, BlueprintNodeType } from "./types";

/** Skip parseSync above this size (256 KB). */
export const OXC_MAX_BYTES = 256 * 1024;

export type MergeKind = "function" | "class" | "route" | "export";

export function nodeMergeKey(relPath: string, kind: MergeKind, normalizedName: string): string {
  return `${relPath}:${kind}:${normalizedName.toLowerCase()}`;
}

export function isTsLikePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx")
  );
}

/**
 * Extract Blueprint nodes via oxc-parser worker pool. Returns null when skipped or parse fails.
 */
export async function extractNodesFromOxc(
  content: string,
  absolutePath: string,
  relPath: string,
  idOffset: number,
): Promise<BlueprintNode[] | null> {
  if (!isTsLikePath(absolutePath)) return null;
  const byteLen = Buffer.byteLength(content, "utf8");
  if (byteLen > OXC_MAX_BYTES) return null;

  const nodes = await parseInWorker(absolutePath, content, relPath, idOffset);
  if (nodes.length === 0) {
    const program = oxcParseProgram(absolutePath, content);
    if (!program) return null;
    const syncNodes = walkProgramToNodes(program, relPath, idOffset);
    return syncNodes.length > 0 ? syncNodes : null;
  }
  return nodes;
}

/** Parse in-process (sync — tests and fallback only). */
export function extractNodesFromOxcSync(
  content: string,
  absolutePath: string,
  relPath: string,
  idOffset: number,
): BlueprintNode[] | null {
  if (!isTsLikePath(absolutePath)) return null;
  if (Buffer.byteLength(content, "utf8") > OXC_MAX_BYTES) return null;
  const program = oxcParseProgram(absolutePath, content);
  if (!program) return null;
  return walkProgramToNodes(program, relPath, idOffset);
}

function blueprintTypeToMergeKind(type: BlueprintNodeType, node: BlueprintNode): MergeKind | null {
  if (type === "api" || type === "webhook") return "route";
  if (type === "class") return "class";
  if (type === "function") return "function";
  if (type === "feature" && node.name.startsWith("import:")) return null;
  if (type === "feature" && node.name.startsWith("export:")) return "export";
  return "function";
}

function normalizedNameForNode(node: BlueprintNode, kind: MergeKind): string {
  if (kind === "route") {
    const method = (node.method ?? "GET").toUpperCase();
    const routePath = node.path ?? node.name;
    return `${method} ${routePath}`.trim();
  }
  if (kind === "export" && node.name.startsWith("export:")) {
    return node.name.slice("export:".length);
  }
  return node.name;
}

/**
 * Merge oxc-extracted nodes with regex-extracted nodes per documented precedence.
 */
export function mergeBlueprintNodes(oxcNodes: BlueprintNode[], regexNodes: BlueprintNode[]): BlueprintNode[] {
  const oxcByKey = new Map<string, BlueprintNode>();
  for (const n of oxcNodes) {
    const kind = blueprintTypeToMergeKind(n.type, n);
    if (!kind) continue;
    oxcByKey.set(nodeMergeKey(n.file, kind, normalizedNameForNode(n, kind)), n);
  }

  const merged: BlueprintNode[] = [];
  const seenIds = new Set<string>();
  const add = (n: BlueprintNode) => {
    if (!seenIds.has(n.id)) {
      seenIds.add(n.id);
      merged.push(n);
    }
  };

  for (const n of oxcNodes) add(n);

  for (const regexNode of regexNodes) {
    const kind = blueprintTypeToMergeKind(regexNode.type, regexNode);
    if (!kind) continue;
    const key = nodeMergeKey(regexNode.file, kind, normalizedNameForNode(regexNode, kind));
    const oxcMatch = oxcByKey.get(key);

    if (kind === "route") {
      add(regexNode);
      continue;
    }

    if (oxcMatch) {
      const oxcLine = oxcMatch.line ?? 0;
      const regexLine = regexNode.line ?? 0;
      if (regexNode.type === "api" && Math.abs(oxcLine - regexLine) > 5) {
        add(regexNode);
      }
      continue;
    }

    if (kind === "function" || kind === "class") {
      add(regexNode);
    }
  }

  return merged;
}

/** @internal Walk nested node for tests */
export function visitProgramBody(program: Program, visitor: (stmt: Statement) => void): void {
  for (const stmt of program.body) visitor(stmt);
}

export type { Node };
