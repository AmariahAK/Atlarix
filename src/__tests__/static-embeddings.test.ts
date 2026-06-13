import { afterEach, describe, expect, it } from "vitest";
import {
  cosineSim,
  embedQuery,
  embedText,
  fuseRankedLists,
  hasStaticEmbeddingModel,
  setStaticEmbeddingModel,
  type StaticEmbeddingModel,
} from "@/lib/search/static-embeddings";

/** Tiny synthetic model: 3-dim vectors keyed by word, whitespace tokenizer. */
const VOCAB: Record<string, Float32Array> = {
  refund: new Float32Array([1, 0, 0]),
  payment: new Float32Array([0.9, 0.2, 0]),
  edge: new Float32Array([0, 1, 0]),
  case: new Float32Array([0, 0.9, 0.1]),
  banana: new Float32Array([0, 0, 1]),
};
const WORDS = Object.keys(VOCAB);
const model: StaticEmbeddingModel = {
  dim: 3,
  tokenize: (t) =>
    t
      .toLowerCase()
      .split(/\W+/)
      .filter(Boolean)
      .map((w) => WORDS.indexOf(w))
      .filter((i) => i >= 0),
  vectorAt: (id) => VOCAB[WORDS[id]!],
};

describe("static embeddings (Model2Vec-style)", () => {
  afterEach(() => setStaticEmbeddingModel(null));

  it("produces an L2-normalized mean-pooled vector", () => {
    const v = embedText(model, "refund payment")!;
    expect(v).not.toBeNull();
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("scores related text higher than unrelated text (semantic-ish)", () => {
    const q = embedText(model, "refund edge case")!;
    const related = embedText(model, "payment refund")!;
    const unrelated = embedText(model, "banana")!;
    expect(cosineSim(q, related)).toBeGreaterThan(cosineSim(q, unrelated));
  });

  it("returns null for empty / all-OOV text", () => {
    expect(embedText(model, "")).toBeNull();
    expect(embedText(model, "zzz qqq")).toBeNull();
  });

  it("embedQuery is a no-op until a model is registered (safe default)", () => {
    expect(hasStaticEmbeddingModel()).toBe(false);
    expect(embedQuery("refund")).toBeNull();
    setStaticEmbeddingModel(model);
    expect(hasStaticEmbeddingModel()).toBe(true);
    expect(embedQuery("refund")).not.toBeNull();
  });

  it("fuseRankedLists ranks items strong across lists highest, honoring weights", () => {
    const bm25 = ["a", "b", "c"];
    const ripgrep = ["b", "a", "c"];
    const embed = ["a", "c", "b"];
    const fused = fuseRankedLists([
      { ids: bm25, weight: 2 },
      { ids: ripgrep, weight: 1 },
      { ids: embed, weight: 1 },
    ]);
    expect(fused[0]).toBe("a"); // rank 1 in bm25 (weighted 2) + embed
    expect(fused).toHaveLength(3);
  });

  it("cosineSim of identical normalized vectors is ~1", () => {
    const v = embedText(model, "refund payment edge")!;
    expect(cosineSim(v, v)).toBeCloseTo(1, 5);
  });
});
