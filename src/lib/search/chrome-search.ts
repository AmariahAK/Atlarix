/**
 * Web search through the user's own Chrome, via the Atlarix extension (the
 * bridge's `search` op): the engine's results page in a background tab of this
 * Atlarix's tab group, read and closed. This is how the CLI — which has no
 * built-in browser — searches; the app uses it when its hidden window can't.
 *
 * `[]` when no browser is connected, when the extension is older than the op,
 * or when the engines answered with a bot check.
 */
import log from "electron-log";
import type { UnifiedSearchResult } from "./index";

const logger = log.scope("chrome-search");

/** Two engines, each a page load, inside the bridge's own per-request timeout. */
const SEARCH_TIMEOUT_MS = 45_000;

export async function chromeSearch(query: string, limit = 10): Promise<UnifiedSearchResult[]> {
  let endpoint;
  try {
    const { bridge } = await import("@/main/bridge-lifecycle");
    endpoint = bridge();
  } catch {
    return [];
  }
  if (!endpoint?.connected) return [];
  try {
    const res = (await endpoint.request("search", { query, max: limit }, SEARCH_TIMEOUT_MS)) as {
      engine: string | null;
      results?: Array<{ title: string; url: string; snippet?: string }>;
      challenged?: boolean;
    };
    const rows = res.results ?? [];
    if (res.challenged) logger.info(`chrome search for "${query}" was challenged by the engines`);
    return rows.map((r, i) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet ?? "",
      score: rows.length - i,
      source: `chrome:${res.engine ?? "?"}`,
    }));
  } catch (e) {
    // An extension older than the op says "has no bridged op": no search, not an error.
    logger.info(`chrome search unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
