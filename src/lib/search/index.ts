/**
 * Search Module
 * =============
 * Smart search for Atlarix, in tiers.
 *
 * Tier 0: Atlarix's own Chromium - the only one that passes a bot check (the app)
 * Tier 0b: the user's Chrome      - through the extension (the CLI; the app's
 *           fallback) (chrome-search.ts)
 * Tier 1: SearxNG (self-hosted)  - unmetered and private, when the user runs one
 * Tier 2: DDG Instant API        - an instant-ANSWER API, NOT a web search
 *
 * No search API is built in (owner decision 2026-10-02): with no browser, search
 * comes from an MCP server the user adds, and the CLI says so (tools/web.ts).
 *
 * The last line is not a criticism, it is the measurement. On 2026-08-19, three
 * ordinary developer queries run through every tier within the same minute:
 *
 *   browser         24 / 29 / 25 results
 *   public SearxNG   0 /  0 /  0   - all five instances failed every query
 *   DDG              0 /  0 /  0
 *
 * That is why tier 0 exists. The public-SearxNG tier was DELETED on the strength
 * of those numbers: it never contributed a result and cost five HTTP requests on
 * the way to every miss. The two tiers left below the browser stay because
 * HEADLESS stubs Electron and has no browser at all, so they are its only search.
 */

export { searchDDGInstant } from "./duckduckgo";
export {
  searchSearxng,
  getSearxngURL,
  isSearxngEnabled,
  stripSiteOperators,
} from "./searxng";

export interface UnifiedSearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
  source: string;
  metadata?: Record<string, any>;
}

/**
 * Smart unified search - returns the first tier that finds anything.
 * Priority: browser > SearxNG (self-hosted) > Public SearxNG > DDG Instant
 */
export async function smartSearch(
  query: string,
  limit: number = 10,
): Promise<UnifiedSearchResult[]> {
  const { searchSearxng, stripSiteOperators } = await import("./searxng");
  const { searchDDGInstant } = await import("./duckduckgo");
  const { getSearxngConfig } = await import("./config");

  const stripped = stripSiteOperators(query).trim();
  const effectiveQuery = stripped.length > 0 ? stripped : query.trim();

  // Tier 0: Atlarix's own Chromium.
  //
  // Measured 2026-08-19, every tier below this returned NOTHING for ordinary
  // developer queries — DDG's Instant Answer API gives 0 results, four of five
  // public SearxNG instances answer 429, and searx.be serves a "Verifying your
  // browser…" challenge. Those are all the same question, and a real browser is
  // the answer to it.
  //
  // Imported lazily and guarded: this module touches `electron`, and the
  // headless build stubs `BrowserWindow` as a non-constructor. Any failure
  // returns [] and falls through, so the chain below is unchanged.
  try {
    const { browserSearch, isBrowserSearchAvailable } = await import(
      "./browser-search"
    );
    if (isBrowserSearchAvailable()) {
      // The RAW query, not the stripped one. `site:` is stripped for the tiers
      // below because they handle it badly — but a real engine implements it,
      // and stripping it silently discards the caller's scoping.
      const viaBrowser = await browserSearch(query.trim() || effectiveQuery, {
        limit,
      });
      if (viaBrowser.length > 0) {
        return viaBrowser.map((r, i) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          // Document order IS the engine's ranking, and the only ranking
          // signal available; preserve it as a descending score.
          score: viaBrowser.length - i,
          source: "browser",
        }));
      }
    }
  } catch {
    /* never let the browser tier break the chain */
  }

  // Tier 0b: the user's own Chrome, through the extension.
  try {
    const { chromeSearch } = await import("./chrome-search");
    const viaChrome = await chromeSearch(query.trim() || effectiveQuery, limit);
    if (viaChrome.length > 0) return viaChrome;
  } catch {
    /* never let a tier break the chain */
  }

  // Get unified config (works in both renderer and main process)
  const config = getSearxngConfig();
  console.log("[SmartSearch] Config:", config);

  // Tier 1: Self-hosted SearxNG
  if (config.enabled && config.url) {
    console.log("[SmartSearch] Using self-hosted SearxNG:", config.url);
    const results = await searchSearxng(
      effectiveQuery,
      undefined,
      limit,
      config.url,
    );
    if (results.length > 0) {
      return results;
    }
    console.log("[SmartSearch] SearxNG returned 0 results, falling back...");
  }

  // Tier 2: DuckDuckGo Instant API — the floor, and headless's last resort
  console.log("[SmartSearch] Falling back to DDG Instant API");
  return searchDDGInstant(effectiveQuery, limit);
}
