/**
 * Pure FTS5 query contract — schema, bm25 column weights, the pre-tokenized
 * column projection, and the MATCH builder. No electron/native/ctags imports, so
 * the lexical ranking design is unit-testable in plain Node (see the parity test)
 * while `fts5-index.ts` owns the runtime wiring (DB open, ctags, embeddings).
 */

import { tokenizedText, isGenericIdentifierName } from "./retrieval-common";

/**
 * Bump when the `symbols` columns change. On open, a stored version mismatch
 * drops + recreates the table (then a normal rebuild repopulates it), so an old
 * on-disk index can't be queried with the wrong column shape.
 */
export const SCHEMA_VERSION = "3";

/** Idempotent schema (created on every DB open). */
export const FTS5_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS symbols USING fts5(
    name, name_generic, signature, snippet,
    abs_file UNINDEXED, rel_file UNINDEXED, line UNINDEXED, package UNINDEXED,
    tokenize = 'unicode61'
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * Per-column bm25 weights in declaration order (UNINDEXED columns weigh 0). This
 * reproduces the Tier-1 field reweight: name ≫ signature > snippet ≫ name_generic.
 */
export const BM25_WEIGHTS = [5.0, 1.0, 2.0, 1.5, 0, 0, 0, 0];

export const INSERT_SQL =
  `INSERT INTO symbols (name, name_generic, signature, snippet, abs_file, rel_file, line, package)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * The four searchable (pre-tokenized) column values for a symbol. A symbol whose
 * WHOLE name is generic ("handle", "process", …) goes to the low-weight
 * `name_generic` column so it can't outrank a specific match on a shared token.
 */
export function searchableColumns(
  name: string,
  signature: string,
  snippet: string,
): [string, string, string, string] {
  const generic = isGenericIdentifierName(name);
  return [
    generic ? "" : tokenizedText(name),
    generic ? tokenizedText(name) : "",
    tokenizedText(signature),
    tokenizedText(snippet),
  ];
}

/** MATCH expression: OR of quoted, tokenized query terms. null when empty. */
export function toMatch(query: string): string | null {
  const toks = [...new Set(tokenizedText(query).split(" ").filter(Boolean))];
  if (toks.length === 0) return null;
  // Tokens are [a-z0-9_]; quote them so no FTS5 operator is ever interpreted.
  return toks.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}
