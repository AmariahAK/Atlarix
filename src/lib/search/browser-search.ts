/**
 * Web search through Atlarix's own Chromium.
 *
 * WHY THIS TIER EXISTS
 * --------------------
 * Measured 2026-08-19, the client search chain returned NOTHING for ordinary
 * developer queries: DuckDuckGo's Instant Answer API gave 0 results (it is an
 * instant-ANSWER API, not a web search), four of five public SearxNG instances
 * answered HTTP 429, and `searx.be` served a "Verifying your browser…" challenge
 * that parsed to zero. So any Core user without a self-hosted SearxNG had a
 * `web_search` that silently found nothing.
 *
 * Every one of those failures is the same question — "is this a real browser?" —
 * and Atlarix ships a real one. This tier asks the engine the way a person would:
 * a genuine Chromium, with a persistent profile, loading the results page. On the
 * same three queries it returned 24 / 29 / 25 results.
 *
 * WHAT IT IS NOT
 * --------------
 * This is not the agent driving the browser. The model never sees this window,
 * cannot address it, and it never becomes a user-visible tab. It is a search
 * BACKEND that happens to be implemented with a browser.
 *
 * FAILURE IS A TIER, NOT AN ERROR
 * -------------------------------
 * Nothing here may throw into a turn. A challenge page, a timeout, a missing
 * Electron, zero parseable results — all return `[]`, and `smartSearch` falls
 * through to a self-hosted SearxNG and then DDG exactly as before.
 *
 * The hidden-window machinery lives in `lib/browser/headless-page.ts`, shared with
 * `read_url`'s browser fallback.
 */

import log from "electron-log";
import { SEARCH_RESULTS_SCRIPT } from "@/lib/browser/search-results";
import {
  isHiddenPageAvailable,
  withHiddenPage,
} from "@/lib/browser/headless-page";

const logger = log.scope("browser-search");

/** Isolated from the app session, the user's tabs, and `read_url`'s jar. */
const SEARCH_PARTITION = "persist:atlarix-search";
/** A results page that has not loaded by now is not going to be useful. */
const NAV_TIMEOUT_MS = 12_000;

export interface BrowserSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Engines live in ONE table so adding another is data, not code.
 *
 * Brave is the default deliberately. It answered a plain `curl` with a full
 * results page where DuckDuckGo returned an anomaly page (HTTP 202) on both its
 * `html.` and `lite.` endpoints; it runs an independent index rather than
 * reselling another engine's; and it publishes an official Search API, which
 * means that if reading the page ever stops working there is a sanctioned path to
 * the SAME results rather than a rewrite. Google is reachable but its terms
 * prohibit automated queries, so it is never the default.
 */
export const SEARCH_ENGINES = {
  brave: (q: string) =>
    `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q: string) =>
    `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  google: (q: string) =>
    `https://www.google.com/search?q=${encodeURIComponent(q)}`,
} as const;

export type SearchEngineId = keyof typeof SEARCH_ENGINES;
export const DEFAULT_SEARCH_ENGINE: SearchEngineId = "brave";

/**
 * Whether a browser-backed search is possible in this process.
 *
 * The headless build aliases `electron` to a stub whose `BrowserWindow` is a plain
 * OBJECT, not a constructor, so `new` would throw — see `isHiddenPageAvailable`.
 */
export function isBrowserSearchAvailable(): boolean {
  return isHiddenPageAvailable();
}

/**
 * Run one query through the hidden window. Returns `[]` for every failure mode —
 * unavailable, blocked, timed out, or simply nothing parseable — so the caller can
 * fall through without a try/catch.
 */
export async function browserSearch(
  query: string,
  opts: { engine?: SearchEngineId; limit?: number } = {},
): Promise<BrowserSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  if (!isBrowserSearchAvailable()) return [];

  const engine = opts.engine ?? DEFAULT_SEARCH_ENGINE;
  const url = (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE])(
    q,
  );

  const raw = await withHiddenPage(
    url,
    { partition: SEARCH_PARTITION, navTimeoutMs: NAV_TIMEOUT_MS },
    async (wc) =>
      (await wc.executeJavaScript(SEARCH_RESULTS_SCRIPT, true)) as
        | BrowserSearchResult[]
        | null,
  );

  const results = Array.isArray(raw) ? raw : [];
  if (results.length === 0) {
    // A challenge page, an empty page, or markup we no longer recognise — all
    // indistinguishable from here, and all mean "let the next tier try".
    logger.info(
      `[browser-search] ${engine}: no results for "${q}" — falling through`,
    );
  } else {
    logger.info(
      `[browser-search] ${engine}: ${results.length} result(s) for "${q}"`,
    );
  }
  return opts.limit ? results.slice(0, opts.limit) : results;
}
