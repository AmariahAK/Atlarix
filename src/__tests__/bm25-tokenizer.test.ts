import { describe, expect, it } from "vitest";
import { tokenizeForBm25 } from "@/lib/search/bm25_semantic_index";

/**
 * v13.2 — BM25 sub-token tokenization. Compound identifiers must match
 * multi-word queries: the tokenizer emits the full token plus camelCase /
 * snake_case sub-tokens, on both the document and the query side (same
 * prep task via definePrepTasks).
 */

describe("tokenizeForBm25", () => {
  it("keeps plain lowercase words as before", () => {
    expect(tokenizeForBm25("simple words here")).toEqual([
      "simple",
      "words",
      "here",
    ]);
  });

  it("emits camelCase sub-tokens alongside the full token", () => {
    expect(tokenizeForBm25("handleAuthCallback")).toEqual([
      "handleauthcallback",
      "handle",
      "auth",
      "callback",
    ]);
  });

  it("splits snake_case", () => {
    expect(tokenizeForBm25("process_payment_intent")).toEqual([
      "process_payment_intent",
      "process",
      "payment",
      "intent",
    ]);
  });

  it("handles PascalCase with acronym runs", () => {
    expect(tokenizeForBm25("HTMLParser")).toEqual(["htmlparser", "html", "parser"]);
  });

  it("multi-word query tokens overlap compound identifier tokens", () => {
    const doc = new Set(tokenizeForBm25("handleAuthCallback"));
    const query = tokenizeForBm25("auth callback");
    expect(query.every((t) => doc.has(t))).toBe(true);
  });

  it("drops single-character fragments and punctuation", () => {
    expect(tokenizeForBm25("a.b(c)")).toEqual([]);
    expect(tokenizeForBm25("fooBar|x")).toEqual(["foobar", "foo", "bar"]);
  });
});
