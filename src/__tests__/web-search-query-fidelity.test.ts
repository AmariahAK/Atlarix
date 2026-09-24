/**
 * What actually gets searched for.
 *
 * From a real session: the agent asked to verify two quotes by exact phrase and got
 * SEO/developer pages for one and nothing at all for the other. Neither search ever
 * reached the engine as written — `optimizeQuery` reduced every query to six
 * keywords, stripping stopwords straight through quoted spans:
 *
 *   "The mystery of human existence lies not in just staying alive, but in finding
 *    something to live for" Dostoevsky Brothers Karamazov
 *      → `"the mystery human existence lies not`      (Brave: no results)
 *
 * Note the dangling unclosed quote. These tests pin the two rules that fix it — a
 * quoted phrase is never broken up, and a search that found pages never reports none.
 */

import { describe, it, expect } from "vitest";
import {
  optimizeSearchQueryKeywords,
  filterRelevantResults,
} from "@/lib/tools/web";

const DOSTOEVSKY =
  '"The mystery of human existence lies not in just staying alive, but in finding something to live for" Dostoevsky Brothers Karamazov';
const BERRY = '"The impeded stream is the one that sings" Wendell Berry';

describe("keyword reduction keeps quoted phrases whole", () => {
  it("never splits or truncates a quoted phrase", () => {
    const out = optimizeSearchQueryKeywords(DOSTOEVSKY);
    expect(out).toContain(
      '"The mystery of human existence lies not in just staying alive, but in finding something to live for"',
    );
  });

  it("leaves no unbalanced quote for the engine to choke on", () => {
    for (const q of [DOSTOEVSKY, BERRY]) {
      const quoteCount = (optimizeSearchQueryKeywords(q).match(/"/g) ?? [])
        .length;
      expect(quoteCount % 2).toBe(0);
    }
  });

  it("keeps the attribution that used to fall off the end", () => {
    // "Wendell Berry" sat past the six-keyword cut, so the search lost the very
    // thing that identified the quote.
    const out = optimizeSearchQueryKeywords(BERRY).toLowerCase();
    expect(out).toContain("wendell");
    expect(out).toContain("berry");
  });

  it("still reduces an unquoted, chatty query — that part was never the problem", () => {
    const out = optimizeSearchQueryKeywords(
      "how do I fix the TypeError cannot read properties of undefined in my react component when the state updates",
    );
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(6);
    expect(out).toContain("typeerror");
  });

  it("falls back to the raw query rather than returning nothing", () => {
    expect(optimizeSearchQueryKeywords("why is it so")).toBe("why is it so");
  });
});

describe("relevance filtering never turns results into no results", () => {
  const result = (title: string, url: string, snippet = "") => ({
    source: "general",
    title,
    url,
    snippet,
    score: 1,
    metadata: {},
  });

  it("keeps the best matches when some clear the bar", () => {
    const out = filterRelevantResults(
      [
        result("Wendell Berry — The Real Work", "https://example.com/berry"),
        result("Unrelated cooking blog", "https://example.com/soup"),
      ],
      "wendell berry real work poem",
      5,
    );
    expect(out[0].url).toBe("https://example.com/berry");
  });

  it("returns a ranked best-effort list when NOTHING clears the bar", () => {
    // The live failure: the search ran on a mangled fragment, so the pages it found
    // scored below the whole-query bar and the tool reported zero — for a query the
    // engine had answered with 25 hits.
    const found = [
      result("Some page", "https://example.com/a"),
      result("Another page", "https://example.com/b"),
    ];
    const out = filterRelevantResults(found, DOSTOEVSKY, 5);
    expect(out.length).toBeGreaterThan(0);
  });

  it("still respects the result cap", () => {
    const found = Array.from({ length: 10 }, (_, i) =>
      result(`Page ${i}`, `https://example.com/${i}`),
    );
    expect(filterRelevantResults(found, DOSTOEVSKY, 3)).toHaveLength(3);
  });

  it("returns nothing only when it was given nothing", () => {
    expect(filterRelevantResults([], DOSTOEVSKY, 5)).toEqual([]);
  });
});
