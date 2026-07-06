/**
 * Parse Universal Ctags JSON output into SymbolRecord[].
 */

import { createHash } from "crypto";
import * as path from "node:path";
import type { SymbolRecord } from "./symbol-types";

export type RawCtagsJsonLine = {
  name?: string;
  path?: string;
  line?: number | string;
  kind?: string;
  end?: number | string;
  scope?: string;
  signature?: string;
  typeref?: string;
  language?: string;
};

function stableSymbolId(relPath: string, name: string, line: number, kind: string): string {
  return createHash("sha256")
    .update(`${relPath}\0${name}\0${line}\0${kind}`)
    .digest("hex")
    .slice(0, 16);
}

function normalizeKind(kind: string | undefined): string {
  if (!kind) return "unknown";
  return kind.length === 1 ? kind : kind.toLowerCase();
}

function ctagsKindToNodeType(kind: string): "function" | "class" | "feature" | "api" {
  const k = kind.toLowerCase();
  if (k === "f" || k === "function" || k === "method" || k === "m") return "function";
  if (k === "c" || k === "class") return "class";
  if (k === "i" || k === "interface" || k === "t" || k === "type") return "feature";
  return "function";
}

export { ctagsKindToNodeType };

/**
 * Parse newline-delimited JSON from ctags stdout.
 * @param workspaceRoot Absolute workspace root for making paths relative.
 */
export function parseCtagsJsonOutput(
  stdout: string,
  workspaceRoot: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("{") === false) continue;
    let row: RawCtagsJsonLine;
    try {
      row = JSON.parse(trimmed) as RawCtagsJsonLine;
    } catch {
      continue;
    }
    const name = row.name?.trim();
    const filePath = row.path?.replace(/\\/g, "/");
    if (!name || !filePath) continue;

    const absRoot = path.resolve(workspaceRoot);
    const absFile = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(absRoot, filePath);
    let rel = path.relative(absRoot, absFile).replace(/\\/g, "/");
    if (rel.startsWith("..")) {
      // Fallback when ctags emits a path shape path.relative cannot normalize (e.g. 8.3 vs long path).
      const normRoot = absRoot.replace(/\\/g, "/").replace(/\/$/, "");
      const normFile = absFile.replace(/\\/g, "/");
      if (normFile.startsWith(`${normRoot}/`)) {
        rel = normFile.slice(normRoot.length + 1);
      } else {
        rel = filePath;
      }
    }

    const lineNum = Number(row.line);
    if (!Number.isFinite(lineNum) || lineNum < 1) continue;

    const kind = normalizeKind(row.kind);
    const id = stableSymbolId(rel, name, lineNum, kind);
    if (seen.has(id)) continue;
    seen.add(id);

    const endLine = row.end != null ? Number(row.end) : undefined;
    symbols.push({
      id,
      name,
      kind,
      path: rel,
      line: lineNum,
      endLine: Number.isFinite(endLine) ? endLine : undefined,
      scope: row.scope?.trim() || undefined,
      signature: row.signature?.trim() || row.typeref?.trim() || undefined,
      language: row.language?.trim().toLowerCase() || undefined,
    });
  }

  return symbols;
}
