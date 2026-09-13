/**
 * The search-result extractor, run against a REAL captured results page.
 *
 * The fixture is a genuine Brave results page (207 KB, saved 2026-08-19) rather
 * than hand-written HTML, because the whole risk in this code is that a real
 * engine's markup does not look the way anyone imagines. A hand-made fixture would
 * test the imagination.
 *
 * It is also saved rather than fetched: a network test here would be flaky, would
 * fail in CI for reasons unrelated to the code, and — far worse — would PASS
 * silently on an empty page, which is exactly the failure it exists to catch.
 *
 * The script text itself is evaluated, not a re-implementation of it, for the same
 * reason as the WebAuthn shim: it ships as a string through `executeJavaScript`, so
 * a syntax error in it fails nothing at build time and simply yields no results.
 */
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { type ExtractedSearchResult } from "@/lib/browser/search-results";
import {
  MAX_SEARCH_RESULTS,
  atlarixPageKernel,
  type SearchResultsPayload,
} from "@/lib/browser/page-scripts";

/**
 * Evaluate the real kernel against a DOM, as Chromium would.
 *
 * EVALUATED FROM ITS SOURCE, not called directly, and that is the point of the
 * exercise: the kernel is stringified and injected, so it may not close over
 * anything in its module. Running it through `new Function` in a scope that
 * holds only the page globals is what proves that — calling the import would
 * pass even if the body referenced a module-level constant that will not exist
 * in the page.
 */
function extractFrom(html: string, pageUrl: string): ExtractedSearchResult[] {
  const dom = new JSDOM(html, { url: pageUrl });
  const { window } = dom;
  // jsdom implements textContent but not layout-dependent innerText; the kernel
  // already falls back to textContent, which is what runs here.
  const run = new Function(
    "document",
    "location",
    "URL",
    "window",
    `return (${atlarixPageKernel.toString()})({op:"search-results",max:${MAX_SEARCH_RESULTS}})`,
  );
  return (
    run(window.document, window.location, window.URL, window) as
      SearchResultsPayload
  ).results;
}

let results: ExtractedSearchResult[];

beforeAll(() => {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", "brave-search-results.html"),
    "utf8",
  );
  results = extractFrom(
    html,
    "https://search.brave.com/search?q=electron+43+breaking+changes",
  );
});

describe("the search-results kernel op against a real Brave results page", () => {
  it("finds real organic results", () => {
    expect(results.length).toBeGreaterThanOrEqual(5);
  });

  it("every result has an absolute off-site URL and a plausible title", () => {
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThanOrEqual(12);
      expect(r.title.length).toBeLessThanOrEqual(300);
    }
  });

  it("EXCLUDES the engine's own links — the chrome must never look like a result", () => {
    // Brave's own page is full of tempting anchors: Premium, the API, the
    // transparency report, security disclosure. None is a search result.
    const hosts = results.map((r) =>
      new URL(r.url).hostname.replace(/^www\./, ""),
    );
    expect(hosts.some((h) => h === "search.brave.com")).toBe(false);
    expect(
      hosts.some((h) => h === "brave.com" || h.endsWith(".brave.com")),
    ).toBe(false);
  });

  it("de-duplicates by URL — engines repeat a destination as title plus sitelink", () => {
    const urls = results.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("surfaces results relevant to the query, not just any link", () => {
    // The captured query was "electron 43 breaking changes".
    const blob = results
      .map((r) => `${r.title} ${r.url}`)
      .join(" ")
      .toLowerCase();
    expect(blob).toContain("electron");
  });

  it("preserves document order, which is the engine's ranking", () => {
    const html = fs.readFileSync(
      path.join(__dirname, "fixtures", "brave-search-results.html"),
      "utf8",
    );
    const first = results[0]!;
    const second = results[1]!;
    expect(html.indexOf(first.url)).toBeLessThan(html.indexOf(second.url));
  });
});

describe("the search-results kernel op, edge cases", () => {
  const page = (body: string) =>
    `<!doctype html><html><body>${body}</body></html>`;

  it("returns [] for a page with no results rather than throwing", () => {
    expect(
      extractFrom(page("<p>nothing here</p>"), "https://search.brave.com/"),
    ).toEqual([]);
  });

  it("returns [] for a challenge page — the tier must fall through, not guess", () => {
    const challenge = page(
      "<h1>Verifying your browser…</h1><p>Please wait while we check your browser.</p>",
    );
    expect(extractFrom(challenge, "https://searx.be/search")).toEqual([]);
  });

  it("skips anchors inside nav, header, footer and aside", () => {
    const body = `
      <nav><a href="https://example.com/nav">A navigation link that is long enough</a></nav>
      <header><a href="https://example.com/head">A header link that is long enough</a></header>
      <footer><a href="https://example.com/foot">A footer link that is long enough</a></footer>
      <aside><a href="https://example.com/side">An aside link that is long enough</a></aside>
      <main><a href="https://example.com/real">A genuine result title goes here</a>
        <p>And a description sitting beside it that is clearly longer than the title.</p>
      </main>`;
    const out = extractFrom(page(body), "https://search.brave.com/search");
    expect(out.map((r) => r.url)).toEqual(["https://example.com/real"]);
  });

  it("drops short link text like pagination and icons", () => {
    const body = `<main>
      <a href="https://example.com/next">Next</a>
      <a href="https://example.com/ok">A result title of sufficient length</a>
    </main>`;
    const out = extractFrom(page(body), "https://search.brave.com/search");
    expect(out.map((r) => r.url)).toEqual(["https://example.com/ok"]);
  });

  it("takes a snippet from beside the title, and does not just repeat the title", () => {
    const body = `<main><div>
      <a href="https://example.com/x">The Result Title Here</a>
      <p>A description that explains the page and is longer than the title itself.</p>
    </div></main>`;
    const [r] = extractFrom(page(body), "https://search.brave.com/search");
    expect(r!.snippet).toContain("explains the page");
    expect(r!.snippet.startsWith("The Result Title Here")).toBe(false);
  });

  it("treats a subdomain of the engine as engine chrome too", () => {
    const body = `<main>
      <a href="https://help.search.brave.com/article">A help article about searching</a>
      <a href="https://example.com/real">A genuine external result title</a>
    </main>`;
    const out = extractFrom(page(body), "https://search.brave.com/search");
    expect(out.map((r) => r.url)).toEqual(["https://example.com/real"]);
  });
});
