/**
 * Read search results off a rendered results page.
 *
 * WHY A REAL BROWSER AT ALL
 * -------------------------
 * Measured 2026-08-19, Core's `web_search` returned NOTHING: DuckDuckGo's Instant
 * Answer API gives 0 results for developer queries (it is an instant-ANSWER API,
 * never a web search), four of five public SearxNG instances answer HTTP 429, and
 * `searx.be` serves a "Verifying your browser…" challenge that parses to zero.
 * Every one of those is an "is this a real browser?" check — and Atlarix ships a
 * real Chromium. A plain `fetch` cannot pass them; a browser tab can.
 *
 * WHY NOT THE ACCESSIBILITY TREE
 * ------------------------------
 * The obvious idea is to reuse `a11y-snapshot.ts`, since an accessibility tree is
 * far more stable than CSS classes. It cannot work here: `A11yElement` carries
 * `role`, `name` and `text` but **no href**, and the URL is the entire point of a
 * search result.
 *
 * SO: STRUCTURE, NOT CLASS NAMES
 * ------------------------------
 * Engines rewrite their markup constantly and their class names mean nothing a
 * month later, so nothing here matches a class, id or data attribute. A result is
 * derived from shape instead: an anchor that leaves the engine's own host, carries
 * visible text of plausible title length, and sits outside the page's chrome. That
 * is still a heuristic — it is just the most durable one available, and every
 * caller treats an empty return as "fall through to the next tier", never an error.
 */

/** One extracted result. Mirrors `UnifiedSearchResult` minus the scoring fields. */
export interface ExtractedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * WHAT USED TO BE HERE: `SEARCH_RESULTS_SCRIPT`, a string spliced into
 * `executeJavaScript`.
 *
 * MOVED INTO THE SHARED KERNEL on 2026-09-13 as `{op: "search-results"}` — the
 * same string-to-function conversion `atlarixPageKernel` itself went through,
 * and for the same reason: MV3 cannot execute a code string, so the extension
 * could never have used this. Keeping it here would have meant a second
 * extractor in the surface that is BEST placed to run one — the extension sits
 * in the user's real browser, which is exactly what every "is this a real
 * browser?" challenge is testing for.
 *
 * See `page-scripts/index.ts`. `ExtractedSearchResult` stays here because
 * `browser-search.ts` and its fixture test both name it.
 */
