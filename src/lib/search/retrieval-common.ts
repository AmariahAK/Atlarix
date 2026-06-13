/**
 * Shared retrieval primitives used by both the FTS5 lexical engine
 * (`fts5-index.ts`) and the `bm25_semantic_index.ts` facade. Kept in their own
 * module so the engine and the facade don't import each other (no cycle).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const CONTEXT_LINES = 3;

export type Bm25BeaconHit = {
  score: number;
  file: string;
  line: number;
  content: string;
  contextBefore: string[];
  contextAfter: string[];
};

export type Bm25SearchResult = {
  hits: Bm25BeaconHit[];
  totalMatches: number;
  filesIndexed: number;
};

export function normalizeFs(p: string): string {
  return path.normalize(p).replace(/\\/g, "/");
}

/**
 * v13.2: emit each word PLUS its camelCase/snake_case sub-tokens so multi-word
 * queries match compound identifiers ("auth callback" → `handleAuthCallback`).
 * The full lowercased token stays first. Applied to BOTH documents and queries.
 */
export function tokenizeForBm25(text: string): string[] {
  const out: string[] = [];
  for (const word of String(text).split(/[^a-zA-Z0-9_]+/)) {
    if (!word) continue;
    const lower = word.toLowerCase();
    if (lower.length > 1) out.push(lower);
    const subs = word
      .split(/_+/)
      .flatMap((p) =>
        p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/),
      );
    if (subs.length > 1) {
      for (const sub of subs) {
        const s = sub.toLowerCase();
        if (s.length > 1 && s !== lower) out.push(s);
      }
    }
  }
  return out;
}

/** Space-joined tokenized form for storage / MATCH (the FTS5 column text). */
export function tokenizedText(text: string): string {
  return tokenizeForBm25(text).join(" ");
}

/**
 * v12 S20: identifier stop-set — symbols whose WHOLE name is one of these
 * generic words get the name down-weighted (carried in a separate low-weight
 * column) so a `handle`/`get` symbol can't outrank a specific match.
 */
const GENERIC_IDENTIFIER_NAMES = new Set([
  "handle", "handler", "process", "run", "exec", "execute", "init", "setup",
  "get", "set", "make", "do", "call", "apply", "main", "start", "stop",
  "create", "update", "delete", "add", "remove", "load", "save", "fetch",
  "send", "read", "write", "parse", "render", "build", "check", "test",
  "data", "value", "item", "index", "key", "result", "callback", "cb", "fn",
  "util", "utils", "helper", "helpers", "config", "options", "params",
  "new", "default",
]);

export function isGenericIdentifierName(name: string): boolean {
  return GENERIC_IDENTIFIER_NAMES.has(name.trim().toLowerCase());
}

/** Read the line + N lines of context around a hit (for Bm25BeaconHit). */
export async function enrichLineContext(
  absFile: string,
  line: number,
): Promise<Pick<Bm25BeaconHit, "content" | "contextBefore" | "contextAfter">> {
  try {
    const raw = await fs.readFile(absFile, "utf-8");
    const lines = raw.split("\n");
    const idx = Math.max(0, line - 1);
    if (idx >= lines.length) {
      return { content: "", contextBefore: [], contextAfter: [] };
    }
    return {
      content: lines[idx].trim(),
      contextBefore: lines.slice(Math.max(0, idx - CONTEXT_LINES), idx),
      contextAfter: lines.slice(
        idx + 1,
        Math.min(lines.length, idx + CONTEXT_LINES + 1),
      ),
    };
  } catch {
    return { content: "", contextBefore: [], contextAfter: [] };
  }
}
