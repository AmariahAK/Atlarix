/**
 * Paid web search: OpenAI's hosted web search, run by the Atlarix proxy
 * (`POST /v1/search`) and billed to the account (owner, 2026-10-06).
 *
 * Offered only when the turn is paid Atlarix Core (lib/core/paid-core.ts): the
 * model answering may be GLM, Sol or Astra — the search itself always runs on
 * the proxy's cheap OpenAI model, and its results come back here as ordinary
 * results for whichever model is working. Your own key, local models and free
 * Auto keep the browser / extension / MCP path.
 *
 * Returns null whenever this path does not apply or fails, so the caller falls
 * through to the free tiers rather than to an error.
 */
import type { UnifiedSearchResult } from "./index";

export interface PaidSearchResponse {
  results: UnifiedSearchResult[];
  /** The search model's short synthesis, with today's date in mind. */
  summary?: string;
}

export async function paidWebSearch(
  query: string,
  limit: number,
  chatId: number | undefined,
): Promise<PaidSearchResponse | null> {
  const { paidCoreForChat, coreProxyPost } = await import(
    "@/lib/core/paid-core"
  );
  if (!(await paidCoreForChat(chatId).catch(() => false))) return null;
  try {
    const res = await coreProxyPost(
      "/search",
      { json: { query, num_results: limit } },
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res?.ok) return null;
    const body = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; snippet?: string }>;
      summary?: string;
    };
    const rows = (body.results ?? []).filter(
      (r) => typeof r.url === "string" && r.url,
    );
    return {
      results: rows.slice(0, limit).map((r, i) => ({
        title: r.title?.trim() || r.url!,
        url: r.url!,
        snippet: r.snippet?.trim() ?? "",
        score: rows.length - i,
        source: "atlarix",
      })),
      summary:
        typeof body.summary === "string" ? body.summary.trim() : undefined,
    };
  } catch {
    return null;
  }
}
