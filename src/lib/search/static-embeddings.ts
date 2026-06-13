/**
 * On-device static embeddings (Model2Vec-style) — the optional semantic-recall
 * lane that fuses with Blueprint's BM25+structural signals to approach Cursor's
 * fuzzy recall WITHOUT any cloud call, API token, or GPU.
 *
 * A Model2Vec model is just a token→vector table: embedding(text) = L2-normalized
 * mean of its tokens' static vectors. Inference is a few array ops on CPU — no
 * transformer, no network. The pretrained `potion-code-16M` table (~30 MB) is
 * fetched at build time (scripts/fetch-model2vec.mjs) and bundled via
 * extraResource; its tokenizer is injected so this module stays dependency-free
 * and unit-testable with a synthetic model.
 *
 * Default-OFF until a model is loaded and validated on a real build: when no
 * model is registered, every export is a safe no-op and retrieval falls back to
 * Blueprint Tier-1 (RRF + structural). This is the integration seam; wiring the
 * per-symbol document embeddings into the BM25 index build + the third RRF list
 * in the grep reranker / slice ranker is the remaining completion step (see
 * docs/HARNESS-ROADMAP.md).
 */

/** A loaded static-embedding model: a tokenizer + a vocab×dim vector table. */
export interface StaticEmbeddingModel {
  readonly dim: number;
  /** Map text to token ids that index into the vector table. */
  tokenize(text: string): number[];
  /** Static vector for a token id, or undefined for OOV ids. */
  vectorAt(tokenId: number): Float32Array | undefined;
}

let activeModel: StaticEmbeddingModel | null = null;

export function setStaticEmbeddingModel(model: StaticEmbeddingModel | null): void {
  activeModel = model;
}

export function hasStaticEmbeddingModel(): boolean {
  return activeModel !== null;
}

/** L2-normalized mean-pool of a text's token vectors. Null if model/text empty. */
export function embedText(
  model: StaticEmbeddingModel,
  text: string,
): Float32Array | null {
  const ids = model.tokenize(text);
  if (ids.length === 0) return null;

  const acc = new Float32Array(model.dim);
  let counted = 0;
  for (const id of ids) {
    const v = model.vectorAt(id);
    if (!v || v.length !== model.dim) continue;
    for (let d = 0; d < model.dim; d++) acc[d] += v[d]!;
    counted++;
  }
  if (counted === 0) return null;

  // Mean.
  for (let d = 0; d < model.dim; d++) acc[d] /= counted;
  // L2 normalize so cosine similarity is a plain dot product.
  let norm = 0;
  for (let d = 0; d < model.dim; d++) norm += acc[d]! * acc[d]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let d = 0; d < model.dim; d++) acc[d] /= norm;
  return acc;
}

/** Embed with the registered model, or null when none is loaded (no-op default). */
export function embedQuery(text: string): Float32Array | null {
  return activeModel ? embedText(activeModel, text) : null;
}

/** Cosine similarity of two L2-normalized vectors (= dot product). */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Reciprocal Rank Fusion over N ranked lists. Each list is item-ids in rank
 * order (best first); weights bias a list's contribution. Returns ids sorted by
 * fused score (desc). This is the generalization the Blueprint reranker uses to
 * fuse BM25 ⊕ ripgrep ⊕ (optional) embedding rankings.
 */
export function fuseRankedLists(
  lists: Array<{ ids: string[]; weight?: number }>,
  k = 60,
): string[] {
  const score = new Map<string, number>();
  for (const { ids, weight = 1 } of lists) {
    ids.forEach((id, idx) => {
      score.set(id, (score.get(id) ?? 0) + weight / (k + idx + 1));
    });
  }
  return [...score.keys()].sort((a, b) => (score.get(b)! - score.get(a)!));
}
