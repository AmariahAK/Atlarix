/**
 * Atlarix Web Tools
 * ================
 * Two primitives, no modes: `web_search` (query → ranked results) and `read_url`
 * (one page, extracted). Deep research is the agent loop chaining the two —
 * search, pick, read, search again — usually inside the `explore` sub-agent.
 * Every reference tool ships exactly this pair (Claude Code WebSearch/WebFetch,
 * opencode websearch/webfetch); a built-in "deep" mode was a third, overlapping
 * way to research, and the model had to choose between them.
 *
 * - Tiered smart search: Atlarix's own Chromium > self-hosted SearxNG > DDG Instant
 * - Serper API for Google results (optional)
 * - URL content extraction with a JS-shell browser escalation
 * - Caching and in-flight dedup for both
 */

import { ToolRegistry, createParameters, stringParam } from "./registry";
import { smartSearch } from "../search";
import { wrapUntrustedData } from "../streaming/untrusted-data";
import { extractDomain } from "@/lib/format-url";
import { assertUrlAllowed, safeFetch } from "../security/url-policy";

import TurndownService from "turndown";

/**
 * Shown only when a search fails or returns nothing — never in the tool
 * description, which is loaded every turn inside the first prompt-cache
 * breakpoint. Recovery advice belongs where recovery is happening.
 *
 * It no longer mentions SearxNG: search runs through Atlarix's own Chromium, so
 * there is nothing for the user to install. A search/web MCP stays, because that
 * is still a real thing they can add and it depends on nothing we ship.
 */
const WEB_SEARCH_SETUP_HINT =
  "\n\n**If this keeps coming up empty:** search already runs through Atlarix's own browser, so there is nothing to install — try rephrasing as keywords rather than a question. If one site or domain is consistently thin, the user can connect a **search/web MCP** in Settings → Tools & MCP.";

const CLI_WEB_SEARCH_UNAVAILABLE = (query: string) =>
  `**No web results for "${query}". In the Atlarix CLI, web search runs through the Atlarix Chrome extension** ` +
  "(install it and open its side panel once). Without it, add a search MCP server (any search API works that way). " +
  "Tell the user so. `read_url` still works for a page whose address you know.";

/** Default read budget per page (v13.1: raised from 5K — modern docs need more). */
const READ_URL_DEFAULT_MAX = 20_000;
const READ_URL_MAX_CAP = 50_000;
/** Default page-fetch timeout (v13.1: 10–15s was too tight for CDN-slow docs). */
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MAX_MS = 60_000;
/** A real browser UA used on the Cloudflare-challenge retry. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ===== HELPER FUNCTIONS (used by web tools below) =====

/** Lazily-built so importing this module stays cheap. */
let _turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!_turndown) {
    _turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
  }
  return _turndown;
}

/**
 * v13.1: extract the main content and convert HTML → Markdown (preserves
 * headings, lists, code blocks, links) via turndown. Falls back to the plain
 * stripHtml path if turndown throws on weird markup so read_url never breaks.
 */
export function extractReadableContent(
  html: string,
  contentType: string,
): string {
  if (contentType.includes("text/plain")) {
    return html;
  }

  let content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  content = content.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
  content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
  content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");

  const mainMatch =
    content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    content.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (mainMatch) {
    content = mainMatch[1];
  }

  try {
    const md = getTurndown().turndown(content).trim();
    if (md) return md;
  } catch {
    /* fall through to the plain-text path */
  }
  return stripHtml(content).trim();
}

/** Clamp a caller-supplied page length to [1, READ_URL_MAX_CAP]. */
export function clampReadLength(n: unknown, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(READ_URL_MAX_CAP, Math.floor(v));
}

/**
 * v13.1: fetch with a one-shot Cloudflare-challenge retry. When the first
 * response is a 403 carrying `cf-mitigated: challenge`, retry ONCE with a real
 * browser User-Agent (mirrors opencode's webfetch). `doFetch` receives the
 * headers to use so the policy/redirect handling in safeFetch is re-applied.
 */
export async function fetchWithCfRetry(
  doFetch: (headers: Record<string, string>) => Promise<Response>,
  baseHeaders: Record<string, string>,
): Promise<Response> {
  const first = await doFetch(baseHeaders);
  if (
    first.status === 403 &&
    first.headers.get("cf-mitigated") === "challenge"
  ) {
    return doFetch({ ...baseHeaders, "User-Agent": BROWSER_USER_AGENT });
  }
  return first;
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].trim()) : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

interface SearchResult {
  source: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
  metadata: Record<string, any>;
}

/**
 * `read_url`'s own cookie jar — never search's (`persist:atlarix-search`). An
 * arbitrary page must not be able to read the engine's cookies.
 */
const READER_PARTITION = "persist:atlarix-reader";

/**
 * Statuses where rendering the page in a real browser plausibly changes the
 * answer: a bot wall (403), a rate limit (429), or a challenge served as
 * "unavailable" (503). All three are the "is this a real browser?" question that
 * `fetchWithCfRetry`'s one-shot User-Agent retry tries and often fails to answer —
 * when that retry also fails, its 403 lands here.
 *
 * Deliberately not 401 or 404. A login wall is not something to work around, and
 * a browser renders a 404 page just as faithfully as fetch does.
 */
const BROWSER_ESCALATION_STATUSES = new Set([403, 429, 503]);
/**
 * An HTML document that extracts to less than this is not a document.
 *
 * Measured: excalidraw.com yielded 69 chars ("You need to enable JavaScript to run
 * this app"), play.vuejs.org yielded 18. react.dev yielded 17,682 and
 * sqliteonline.com 17,133, both from a plain fetch.
 */
const JS_SHELL_MAX_TEXT_CHARS = 500;
/** A shell with its bundle inlined rather than linked — big file, no prose. */
const JS_SHELL_MIN_HTML_BYTES = 20_000;
/** A shell that LINKS its bundle. This is the common shape, and it is tiny. */
const EXTERNAL_SCRIPT_RE = /<script[^>]+\bsrc\s*=/i;
/**
 * Covers the paint poll below (3s) with margin, and nothing more.
 *
 * Measured against a Cloudflare-walled page: the challenge navigates while the
 * script is running, which destroys the JS context so `executeJavaScript` never
 * settles — this timeout is the only thing that ends it. Every second here is a
 * second added to a read that is already failing, so it is kept tight.
 */
const BROWSER_EXTRACT_TIMEOUT_MS = 5_000;
/**
 * Below this, a page that has BEEN RENDERED has no readable text at all.
 *
 * Applied only on the escalation path — a page that fetched cleanly is never
 * second-guessed, so a short-but-complete page like example.com is unaffected.
 * Measured: g2.com rendered to the single word "Browse", and play.vuejs.org to
 * its own title. Returning those as a successful read hands the model six
 * characters labelled as the page's content, which it will then repeat. "This
 * page is not readable" is the true answer and the more useful one.
 */
const POST_RENDER_MIN_CHARS = 200;

/**
 * Post-JavaScript HTML, plus the title the framework actually set.
 *
 * `did-finish-load` fires when the bundle has loaded, which for a client-rendered
 * app is BEFORE it has painted anything — grabbing the DOM there would return the
 * same empty shell that made the fetch path fail. So poll briefly for text to
 * appear instead of guessing at a fixed sleep. A page that genuinely has almost no
 * text costs the full wait, which is acceptable on a path only reached after a
 * plain fetch already failed.
 */
const READER_HTML_SCRIPT = `(async () => {
  const textLen = () => ((document.body && document.body.innerText) || "").trim().length;
  for (let i = 0; i < 12 && textLen() < 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    html: document.documentElement ? document.documentElement.outerHTML : "",
    title: document.title || "",
  };
})()`;

/**
 * Render `url` in the shared hidden window and hand back its rendered HTML.
 *
 * ONLY the acquisition of the HTML changes — the caller feeds this to the same
 * `extractReadableContent()` the fetch path uses, so a page produces identical
 * Markdown whichever route reached it.
 *
 * Imported dynamically: `headless-page` touches `electron` at module scope, and
 * `web.ts` is loaded in places (tests, the headless build) that have no real one.
 * Returns `null` for every failure — unavailable, blocked, timed out — so the
 * caller keeps whatever the fetch gave it.
 */
async function fetchViaBrowser(
  url: string,
  navTimeoutMs: number,
): Promise<{ html: string; title: string } | null> {
  // SSRF: the browser path does not go through `safeFetch`, so it does not
  // inherit its policy check. Without this, "read this URL" is a port scanner
  // against localhost and the cloud metadata endpoint. No `allowLoopback` —
  // that is `browser.ts`'s posture, because its job is your own dev server.
  try {
    await assertUrlAllowed(url);
  } catch {
    return null;
  }
  try {
    const { withHiddenPage } = await import("@/lib/browser/headless-page");
    const out = await withHiddenPage(
      url,
      {
        partition: READER_PARTITION,
        navTimeoutMs,
        extractTimeoutMs: BROWSER_EXTRACT_TIMEOUT_MS,
      },
      async (wc) =>
        (await wc.executeJavaScript(READER_HTML_SCRIPT, true)) as {
          html: string;
          title: string;
        } | null,
    );
    return out && typeof out.html === "string" && out.html ? out : null;
  } catch {
    return null;
  }
}

/**
 * True when a fetch produced HTML that is all shell and no document.
 *
 * SIZE ALONE IS THE WRONG TEST, and the first version of this got it wrong.
 * "Large HTML, tiny extraction" only catches a shell that inlines its bundle;
 * the ordinary shape is a *small* `index.html` that LINKS one. Measured, a 20 KB
 * floor let excalidraw.com (69 chars of extracted text) and play.vuejs.org (18)
 * through as if they had been read successfully.
 *
 * So the question is not how big the file is, it is whether the page said its
 * content comes from somewhere we did not go. Either shape qualifies — an
 * external script tag, or a body big enough to be hiding an inline bundle.
 *
 * The `<script src=` half is also what keeps a genuinely small page out of it:
 * example.com extracts to 183 chars and is complete, and it loads no scripts, so
 * it is never escalated.
 *
 * Non-HTML is exempt outright: there is nothing a renderer adds to JSON or text.
 */
function looksLikeJsShell(
  html: string,
  contentType: string,
  extracted: string,
): boolean {
  if (!contentType.includes("text/html")) return false;
  if (extracted.length >= JS_SHELL_MAX_TEXT_CHARS) return false;
  return (
    html.length >= JS_SHELL_MIN_HTML_BYTES || EXTERNAL_SCRIPT_RE.test(html)
  );
}

function truncateForRead(content: string, maxLength: number): string {
  return content.length > maxLength
    ? content.substring(0, maxLength) + "\n\n... [Content truncated]"
    : content;
}

/**
 * Fetch first, browser on failure.
 *
 * Browser-ALWAYS was rejected: the agent often reads several URLs in parallel
 * while the hidden window serializes, which would turn one round of parallel
 * requests into sequential page loads. The browser is the exception path, and
 * `shouldEscalate` below is what keeps it exceptional.
 */
async function fetchUrlContent(
  url: string,
  maxLength: number,
  timeoutMs: number = FETCH_TIMEOUT_MS,
  userAgent: string = "Atlarix/1.0 (Web Reader)",
): Promise<
  { ok: true; title: string; content: string } | { ok: false; error: string }
> {
  /**
   * Last resort: render the page and extract from the rendered DOM.
   *
   * `best` is whatever the fetch already produced, so a render that comes back
   * worse can never downgrade a result — it can only add.
   */
  const viaBrowser = async (
    fallbackError: string,
    best = "",
  ): Promise<
    { ok: true; title: string; content: string } | { ok: false; error: string }
  > => {
    const rendered = await fetchViaBrowser(url, timeoutMs);
    const content = rendered
      ? extractReadableContent(rendered.html, "text/html")
      : "";
    const winner = content.trim().length > best.trim().length ? content : best;

    if (winner.trim().length < POST_RENDER_MIN_CHARS) {
      return {
        ok: false,
        error: winner.trim()
          ? "This page has no readable text — it was rendered in a real browser and still produced almost nothing, which means an app, a canvas, or a login or bot wall rather than a document. It is not publicly readable as text."
          : fallbackError ||
            "This page has no readable text, even rendered in a real browser.",
      };
    }
    return {
      ok: true,
      title:
        rendered?.title ||
        (rendered ? extractTitle(rendered.html) : "") ||
        "Web Page",
      content: truncateForRead(winner, maxLength),
    };
  };

  try {
    const response = await fetchWithCfRetry(
      (headers) => safeFetch(url, { headers }, { timeoutMs }),
      {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,text/plain",
      },
    );

    if (!response.ok) {
      const error = `Failed to fetch URL: ${response.status} ${response.statusText}`;
      if (!BROWSER_ESCALATION_STATUSES.has(response.status))
        return { ok: false, error };
      return viaBrowser(error);
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const content = extractReadableContent(text, contentType);

    // Escalate on a shell, handing over what the fetch already produced so the
    // render can only improve on it.
    if (looksLikeJsShell(text, contentType, content)) {
      return viaBrowser("", content);
    }

    const title = extractTitle(text);
    return {
      ok: true,
      title: title || "Web Page",
      content: truncateForRead(content, maxLength),
    };
  } catch (error) {
    return { ok: false, error: `Failed to read URL: ${error}` };
  }
}

/** NFKC + fullwidth colon → ASCII for search / site: detection */
function normalizeWebSearchUserQuery(raw: string): string {
  return String(raw)
    .normalize("NFKC")
    .replace(/\uFF1A/g, ":")
    .trim();
}

function canonicalWebSearchCacheKey(query: string, numResults: number): string {
  const q = normalizeWebSearchUserQuery(query);
  return `${q}:${numResults}`;
}

/** First `site:…` in query → root URL for direct fetch (ASCII or fullwidth colon; token may be full URL) */
function detectSiteRootUrl(query: string): string | null {
  const m = query.match(/\bsite\s*[:：]\s*([^\s]+)/i);
  if (!m) return null;
  let spec = m[1].replace(/[>)\],.;:]+$/g, "");
  if (!spec) return null;
  if (/^https?:\/\//i.test(spec)) {
    try {
      const u = new URL(spec);
      return u.toString();
    } catch {
      return null;
    }
  }
  const hostPart = spec.split("/")[0].replace(/^\/+/, "");
  if (!hostPart) return null;
  return `https://${hostPart}`;
}

const RELEVANCE_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
]);

export function filterRelevantResults(
  results: SearchResult[],
  query: string,
  maxResults: number,
): SearchResult[] {
  const queryTokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2 && !RELEVANCE_STOP_WORDS.has(t));

  if (queryTokens.length === 0) {
    return results.slice(0, maxResults);
  }

  const scored = results.map((r) => {
    const text = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
    const matches = queryTokens.filter((t) => text.includes(t)).length;
    const relevanceScore = matches / queryTokens.length;
    return { r, relevanceScore };
  });

  const ranked = scored
    .slice()
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .map((x) => x.r);

  const passing = scored
    .filter((x) => x.relevanceScore > 0.25)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .map((x) => x.r);

  // A search that FOUND pages must never report none. This bar is token overlap
  // against the whole query, judged on a title and a short snippet — so a long
  // quoted question can score every genuine hit below 0.25 and empty the result
  // set, which is what produced "0 results" and bare "Done" cards for searches the
  // engine had answered with 25 hits. When the bar rejects everything, fall back to
  // the same list ordered by relevance: best-effort ranking beats a false negative.
  return (passing.length > 0 ? passing : ranked).slice(0, maxResults);
}

function dedupeSearchResultsByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = (r.url || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

interface WebSearchCacheEntry {
  results: SearchResult[];
  timestamp: number;
}

const WEB_SEARCH_GLOBAL_CACHE = new Map<string, WebSearchCacheEntry>();
const WEB_SEARCH_GLOBAL_IN_FLIGHT = new Map<
  string,
  Promise<{ formattedText: string; sources: SearchResult[] }>
>();
const WEB_SEARCH_CACHE_TTL = 60 * 60 * 1000;

function getGlobalWebSearchCached(cacheKey: string): SearchResult[] | null {
  const entry = WEB_SEARCH_GLOBAL_CACHE.get(cacheKey);
  if (!entry) return null;
  const now = Date.now();
  if (now - entry.timestamp > WEB_SEARCH_CACHE_TTL) {
    WEB_SEARCH_GLOBAL_CACHE.delete(cacheKey);
    return null;
  }
  return entry.results;
}

function setGlobalWebSearchCached(
  cacheKey: string,
  results: SearchResult[],
): void {
  WEB_SEARCH_GLOBAL_CACHE.set(cacheKey, { results, timestamp: Date.now() });
  if (WEB_SEARCH_GLOBAL_CACHE.size > 100) {
    const firstKey = WEB_SEARCH_GLOBAL_CACHE.keys().next().value;
    if (firstKey) WEB_SEARCH_GLOBAL_CACHE.delete(firstKey);
  }
}

// ── read_url cache ──────────────────────────────────────────────────────────
//
// A research turn reads the same URL more than once — the agent follows a link,
// comes back to the source to quote it, and up to five sub-agents can be reading
// the same page concurrently. Every one of those was a fresh fetch.
//
// Deliberately SHORTER-lived than the search cache above (15 min vs 1 hour): a
// result list going stale costs you an out-of-date ranking, but a page body going
// stale can make the agent quote something that is no longer there. 15 minutes
// covers a turn without pretending the web stopped moving.

type ReadUrlFetched = { title: string; content: string };

interface ReadUrlCacheEntry {
  fetched: ReadUrlFetched;
  timestamp: number;
  chars: number;
}

const READ_URL_CACHE = new Map<string, ReadUrlCacheEntry>();
const READ_URL_IN_FLIGHT = new Map<
  string,
  Promise<Awaited<ReturnType<typeof fetchUrlContent>>>
>();
const READ_URL_CACHE_TTL = 15 * 60 * 1000;
/**
 * Bounded by CHARACTERS, not entries: page bodies run to hundreds of KB, so an
 * entry cap that is right for the search cache's short rows would let this one
 * hold hundreds of megabytes.
 */
const READ_URL_CACHE_MAX_CHARS = 4_000_000;

/**
 * `maxLength` is part of the key — it changes what the caller gets back.
 *
 * The separator MUST stay written as the escape `\u0000`, never pasted in as a
 * literal NUL byte: ripgrep classifies any file containing one as BINARY and
 * prints "binary file matches" instead of match lines, which `parseGrepOutput`
 * (grep.ts) drops for having no `:<line>:` — so the agent's own grep silently
 * reported "no matches" for every symbol in this file.
 */
function readUrlCacheKey(url: string, maxLength: number): string {
  return `${url.trim()}\u0000${maxLength}`;
}

function getReadUrlCached(cacheKey: string): ReadUrlFetched | null {
  const entry = READ_URL_CACHE.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > READ_URL_CACHE_TTL) {
    READ_URL_CACHE.delete(cacheKey);
    return null;
  }
  return entry.fetched;
}

function setReadUrlCached(cacheKey: string, fetched: ReadUrlFetched): void {
  const chars = fetched.content.length + fetched.title.length;
  // A single oversized page would evict everything else and still not fit.
  if (chars > READ_URL_CACHE_MAX_CHARS) return;
  READ_URL_CACHE.delete(cacheKey); // re-insert so Map order is true LRU-by-write
  READ_URL_CACHE.set(cacheKey, { fetched, timestamp: Date.now(), chars });

  let total = 0;
  for (const e of READ_URL_CACHE.values()) total += e.chars;
  while (total > READ_URL_CACHE_MAX_CHARS) {
    const oldest = READ_URL_CACHE.keys().next().value;
    if (!oldest) break;
    total -= READ_URL_CACHE.get(oldest)?.chars ?? 0;
    READ_URL_CACHE.delete(oldest);
  }
}

/** Test seam — the cache is process-global, so a test that fills it would leak. */
export function __clearReadUrlCacheForTests(): void {
  READ_URL_CACHE.clear();
  READ_URL_IN_FLIGHT.clear();
}

/**
 * `fetchUrlContent` with the cache and concurrent-request dedup in front.
 *
 * Only SUCCESSES are cached: a transient failure that stuck for 15 minutes would
 * be worse than the extra fetch, and the agent's natural response to a failed read
 * is to retry it.
 *
 * Exported for the test that pins it — the whole point is the fetch that does NOT
 * happen, which is invisible from the tool's return value.
 */
export async function fetchUrlContentCached(
  url: string,
  maxLength: number,
  timeoutMs: number = FETCH_TIMEOUT_MS,
  userAgent?: string,
): Promise<Awaited<ReturnType<typeof fetchUrlContent>>> {
  // The User-Agent is deliberately NOT part of the key. It only labels which
  // caller asked; the page it comes back with is the same one. Keying on it would
  // give read_url and the `site:` fetch separate caches, which is the sharing
  // this wrapper exists to provide.
  const cacheKey = readUrlCacheKey(url, maxLength);

  const cached = getReadUrlCached(cacheKey);
  if (cached) {
    return { ok: true, title: cached.title, content: cached.content };
  }

  // Five sub-agents reading the same page should produce one fetch, not five.
  const inFlight = READ_URL_IN_FLIGHT.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const result = await fetchUrlContent(url, maxLength, timeoutMs, userAgent);
    if (result.ok) {
      setReadUrlCached(cacheKey, {
        title: result.title,
        content: result.content,
      });
    }
    return result;
  })().finally(() => {
    READ_URL_IN_FLIGHT.delete(cacheKey);
  });

  READ_URL_IN_FLIGHT.set(cacheKey, promise);
  return promise;
}

// ═══════════════════════════════════════════════════════════
// WEB SEARCH — query → results. No modes.
// ═══════════════════════════════════════════════════════════

/** Results returned when the caller does not say. */
const WEB_SEARCH_DEFAULT_RESULTS = 5;
const WEB_SEARCH_MAX_RESULTS = 10;
/** Budget for the page fetched directly by a `site:` query. */
const SITE_ROOT_FETCH_MAX = 8_000;

function faviconFor(url: string): string | undefined {
  return url
    ? `https://www.google.com/s2/favicons?domain=${extractDomain(url)}&sz=32`
    : undefined;
}

ToolRegistry.register({
  name: "web_search",
  // Deliberately carries NO setup or recovery advice: this string is loaded every
  // turn inside the first prompt-cache breakpoint, so guidance for the rare empty
  // result would be billed on every turn that never sees one. That lives in
  // WEB_SEARCH_SETUP_HINT, which is appended to the failure paths instead.
  description:
    "Search the web. Returns the top results (title, URL, snippet). To go deeper, read the promising pages with read_url and search again.",
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  parameters: createParameters(
    {
      query: stringParam("Search query"),
      num_results: {
        type: "number",
        description: `How many results (default ${WEB_SEARCH_DEFAULT_RESULTS}, max ${WEB_SEARCH_MAX_RESULTS}).`,
      },
    },
    ["query"],
  ),
  // `deep`, `mode`, `sources` and `max_sources` were removed in v14.52.0. Old
  // transcripts and habit-driven models still send them; they are accepted and
  // ignored rather than rejected, so a stale flag never costs a failed call.
  handler: async (args: {
    query?: string;
    input?: { query?: string };
    num_results?: number;
    _chatSessionId?: number;
  }) => {
    const nestedQ =
      args?.input && typeof args.input === "object"
        ? args.input.query
        : undefined;
    const rawQuery =
      typeof args.query === "string" && args.query.trim() !== ""
        ? args.query
        : typeof nestedQ === "string"
          ? nestedQ
          : "";
    const query = normalizeWebSearchUserQuery(rawQuery);

    if (!query) {
      return {
        text: "⚠️ Please provide a search query. Example: web_search({ query: 'React useEffect cleanup' })",
        sources: [],
      };
    }

    const maxResults = Math.min(
      typeof args.num_results === "number" && args.num_results > 0
        ? Math.floor(args.num_results)
        : WEB_SEARCH_DEFAULT_RESULTS,
      WEB_SEARCH_MAX_RESULTS,
    );

    try {
      const siteRoot = detectSiteRootUrl(query);
      if (siteRoot) {
        const fetched = await fetchUrlContentCached(
          siteRoot,
          SITE_ROOT_FETCH_MAX,
        );
        if (!fetched.ok) {
          return {
            text: `**No page fetched for site query**\n\n${fetched.error}\n\n_Tried: ${siteRoot}_`,
            sources: [],
          };
        }
        const snippet =
          fetched.content.length > 500
            ? fetched.content.substring(0, 500) + "…"
            : fetched.content;
        return {
          text: wrapUntrustedData(
            "web_search",
            `**Direct page (site: operator)**\n\n` +
              `📄 **${fetched.title}**\n📍 ${siteRoot}\n\n---\n\n${fetched.content}`,
          ),
          sources: [
            {
              title: fetched.title,
              url: siteRoot,
              content: snippet,
              source: "general",
              score: 100,
              favicon: faviconFor(siteRoot),
            },
          ],
        };
      }

      // Paid Atlarix Core: hosted search through our proxy, billed to the
      // account. Any failure falls through to the free tiers below.
      const { paidWebSearch } = await import("@/lib/search/paid-search");
      const paid = await paidWebSearch(query, maxResults, args._chatSessionId);
      if (paid && paid.results.length > 0) {
        const lines = [`**Search results for: "${query}"**\n`];
        if (paid.summary) lines.push(`${paid.summary}\n`);
        paid.results.forEach((r, idx) => {
          lines.push(`### ${idx + 1}. ${r.title}`);
          lines.push(r.url);
          if (r.snippet) lines.push(`\n> ${r.snippet}\n`);
          lines.push("");
        });
        return {
          text: wrapUntrustedData("web_search", lines.join("\n")),
          sources: paid.results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.snippet,
            source: r.source,
            score: r.score,
            favicon: faviconFor(r.url),
          })),
        };
      }

      const searchResults = await new WebSearchAggregator().search(
        query,
        maxResults,
      );
      console.log(`[web_search] Found ${searchResults.sources.length} results`);

      return {
        // Remote search content is untrusted — data, not instructions.
        text:
          searchResults.sources.length > 0
            ? wrapUntrustedData("web_search", searchResults.formattedText)
            : searchResults.formattedText,
        sources: searchResults.sources.map((result) => ({
          title: result.title,
          url: result.url,
          content: result.snippet,
          source: result.source,
          score: result.score,
          favicon: faviconFor(result.url),
        })),
      };
    } catch (error) {
      console.error("[web_search] Error:", error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const is403Error =
        errorMessage.includes("403") ||
        errorMessage.toLowerCase().includes("rate limit") ||
        errorMessage.toLowerCase().includes("forbidden");

      if (is403Error) {
        return {
          text: `⚠️ **The search engine refused this request** (rate-limited or blocked).

Search runs through Atlarix's own browser, so there is nothing to install — this is the engine throttling, not a missing setup step.

- Wait a moment and retry, or rephrase as keywords rather than a question.
- If a particular site or domain is consistently unreachable this way, a **search/web MCP** can be connected in **Settings → Tools & MCP**.`,
          sources: [],
        };
      }

      return {
        text: `❌ Web search error: ${errorMessage}${WEB_SEARCH_SETUP_HINT}`,
        sources: [],
      };
    }
  },
});

// ═══════════════════════════════════════════════════════════
// URL READING - Perplexica-style content extraction
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
  name: "read_url",
  description:
    "Fetch and read content from a URL — use it when the user gives you a specific URL, or to confirm a primary source. Extracts the main content as Markdown, and renders the page in a real browser when a plain fetch comes back empty, so JavaScript-heavy pages work. Prefer this (and web_search) over opening a browser tab for plain content/reading — reserve the browser tools for pages you need to interact with.",
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true, // Safe for Ask mode - only reads URL content
  parameters: createParameters(
    {
      url: stringParam("URL to fetch"),
      max_length: {
        type: "number",
        description: `Max content chars to return (default ${READ_URL_DEFAULT_MAX}, max ${READ_URL_MAX_CAP}). Content is returned as Markdown.`,
      },
      timeout: {
        type: "number",
        description:
          "Max seconds to wait for the page (default 20, max 60). Raise for slow/large pages.",
      },
    },
    ["url"],
  ),
  handler: async ({
    url,
    max_length,
    timeout,
  }: {
    url: string;
    max_length?: number;
    timeout?: number;
  }) => {
    const maxLen = clampReadLength(max_length, READ_URL_DEFAULT_MAX);
    const timeoutMs = Math.min(
      FETCH_TIMEOUT_MAX_MS,
      Math.max(1000, (Number(timeout) || 20) * 1000),
    );
    const fetched = await fetchUrlContentCached(url, maxLen, timeoutMs);
    if (!fetched.ok) {
      return fetched.error;
    }
    // Remote page content is untrusted — frame it as data, not instructions.
    return wrapUntrustedData(
      `read_url:${url}`,
      `📄 **${fetched.title}**\n📍 ${url}\n\n---\n\n${fetched.content}`,
    );
  },
});

// ═══════════════════════════════════════════════════════════
// SEARCH AGGREGATOR
// ═══════════════════════════════════════════════════════════

/**
 * Keyword reduction — the FALLBACK for a raw query that found nothing.
 *
 * Never the first attempt. This shrinks a query to at most six keywords, which
 * rescues an over-long chatty question no engine matches verbatim, and is
 * destructive for anything written as prose. A real example from a user session:
 *
 *   "The mystery of human existence lies not in just staying alive, but in finding
 *    something to live for" Dostoevsky Brothers Karamazov
 *      → `"the mystery human existence lies not`
 *
 * — the phrase shredded, the author dropped. So the open web always gets the RAW
 * query first (`searchGeneralWithFallback`).
 *
 * Quoted spans survive whole even here: a `"…"` phrase is an explicit instruction to
 * match exactly, and no keyword heuristic may overrule it. They are also exempt from
 * the six-keyword budget, so a quote plus its author cannot push the author out.
 *
 * Exported for the test that pins the phrase rule.
 */
export function optimizeSearchQueryKeywords(rawQuery: string): string {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "as",
    "is",
    "was",
    "are",
    "were",
    "been",
    "be",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "should",
    "could",
    "may",
    "might",
    "can",
    "my",
    "your",
    "i",
    "you",
    "what",
    "how",
    "why",
    "when",
    "where",
    "which",
    "who",
  ]);

  const parts = rawQuery.match(/"[^"]*"|\S+/g) ?? [];
  const quoted: string[] = [];
  const loose: string[] = [];
  for (const part of parts) {
    if (part.startsWith('"') && part.endsWith('"') && part.length > 1) {
      quoted.push(part);
    } else {
      loose.push(part.toLowerCase());
    }
  }

  const keywords = loose.filter((w) => !stopWords.has(w) && w.length > 2);
  const optimized = [...quoted, ...keywords.slice(0, 6)].join(" ").trim();
  return optimized || rawQuery;
}

class WebSearchAggregator {
  private timeout = 10000;

  async search(
    query: string,
    numResults: number,
  ): Promise<{
    formattedText: string;
    sources: SearchResult[];
  }> {
    const cacheKey = canonicalWebSearchCacheKey(query, numResults);

    const cached = getGlobalWebSearchCached(cacheKey);
    if (cached) {
      console.log(`[WebSearch] Cache hit for: ${query}`);
      return {
        formattedText: this.formatResults(query, cached),
        sources: cached,
      };
    }

    const inflight = WEB_SEARCH_GLOBAL_IN_FLIGHT.get(cacheKey);
    if (inflight) {
      console.log(`[WebSearch] In-flight coalesce for: ${query}`);
      return inflight;
    }

    console.log(`[WebSearch] Cache miss, fetching: ${query}`);

    // Reserve in-flight synchronously before any await so parallel identical
    // web_search calls coalesce (avoid TOCTOU between get and set).
    const promise = new Promise<{
      formattedText: string;
      sources: SearchResult[];
    }>((resolve, reject) => {
      queueMicrotask(() => {
        void (async () => {
          try {
            const out = await this.runSearch(query, numResults);
            setGlobalWebSearchCached(cacheKey, out.sources);
            resolve(out);
          } catch (err) {
            reject(err);
          } finally {
            WEB_SEARCH_GLOBAL_IN_FLIGHT.delete(cacheKey);
          }
        })();
      });
    });

    WEB_SEARCH_GLOBAL_IN_FLIGHT.set(cacheKey, promise);
    return promise;
  }

  /**
   * General web search on the RAW query, falling back to the keyword reduction
   * only when the raw query finds nothing.
   *
   * The second round trip is only paid on a search that already failed, so
   * nothing that works today gets slower.
   */
  private async searchGeneralWithFallback(
    rawQuery: string,
    numResults: number,
  ): Promise<SearchResult[]> {
    const direct = await this.searchGeneral(rawQuery, numResults);
    if (direct.length > 0) return direct;
    const optimizedQuery = optimizeSearchQueryKeywords(rawQuery);
    if (!optimizedQuery || optimizedQuery.trim() === rawQuery.trim()) {
      return direct;
    }
    console.log(
      `[WebSearch] raw query found nothing — retrying with keywords: "${optimizedQuery}"`,
    );
    return this.searchGeneral(optimizedQuery, numResults);
  }

  private async runSearch(
    query: string,
    numResults: number,
  ): Promise<{ formattedText: string; sources: SearchResult[] }> {
    const results = await this.searchGeneralWithFallback(query, numResults);
    const deduped = dedupeSearchResultsByUrl(results);
    const top = filterRelevantResults(deduped, query, numResults)
      .sort((a, b) => b.score - a.score)
      .slice(0, numResults);
    return {
      formattedText: this.formatResults(query, top),
      sources: top,
    };
  }

  private formatResults(
    originalQuery: string,
    results: SearchResult[],
  ): string {
    if (results.length === 0) {
      // The `atlarix` CLI has no built-in browser, so the one search tier that
      // passes engines' bot checks is missing there, and an empty answer would
      // read as "nothing exists". Say what is actually going on.
      if (process.env.ATLARIX_SURFACE === "cli")
        return CLI_WEB_SEARCH_UNAVAILABLE(originalQuery);
      return `**No results found for: "${originalQuery}"**\n\n💡 **Suggestions:**\n- Try different keywords\n- Be more specific\n- Check spelling${WEB_SEARCH_SETUP_HINT}`;
    }

    const lines: string[] = [`**Search results for: "${originalQuery}"**\n`];
    results.forEach((result, idx) => {
      lines.push(`### ${idx + 1}. ${result.title}`);
      lines.push(result.url);
      if (result.snippet) {
        lines.push(`\n> ${result.snippet}\n`);
      }
      lines.push("");
    });
    return lines.join("\n");
  }

  async searchGeneral(query: string, limit: number): Promise<SearchResult[]> {
    // Tiered smart search: Atlarix's own Chromium > self-hosted SearxNG > DDG
    // Instant. Falls back automatically through the tiers.
    try {
      console.log("[WebSearch] Using tiered smart search for general");
      const results = await smartSearch(query, limit);
      return results.map((r, idx) => ({
        ...r,
        source: "general",
        // Ensure scores are competitive with MDN (which has 20-60 range)
        score: Math.max(20, 35 - idx * 2),
        metadata: r.metadata || {},
      }));
    } catch (e) {
      console.error("[WebSearch] Smart search failed:", e);
      // Ultimate fallback: Serper if available
      const serperKey = process.env.SERPER_API_KEY;
      if (serperKey) {
        return this.searchSerper(query, limit, serperKey);
      }
      return [];
    }
  }

  async searchSerper(
    query: string,
    limit: number,
    apiKey: string,
  ): Promise<SearchResult[]> {
    try {
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, num: limit }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) return [];
      const data = await response.json();

      const results: SearchResult[] = [];

      // Answer box
      if (data.answerBox) {
        results.push({
          source: "general",
          title: data.answerBox.title || "Quick Answer",
          url: data.answerBox.link || "",
          snippet: data.answerBox.answer || data.answerBox.snippet || "",
          score: 100,
          metadata: { type: "answer_box" },
        });
      }

      // Organic results
      (data.organic || []).slice(0, limit).forEach((item: any) => {
        results.push({
          source: "general",
          title: item.title || "",
          url: item.link || "",
          snippet: item.snippet || "",
          score: item.position ? 10 - item.position : 5,
          metadata: {},
        });
      });

      return results;
    } catch (e) {
      console.error("[WebSearch] Serper error:", e);
      return [];
    }
  }

  async searchDuckDuckGo(
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    try {
      // Use the DuckDuckGo HTML endpoint for actual search results
      // The JSON API only returns instant answers, not real search results
      const response = await fetch(
        `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
        {
          signal: AbortSignal.timeout(this.timeout),
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        },
      );

      if (!response.ok) {
        // Fallback to JSON API for instant answers
        return this.searchDuckDuckGoInstant(query, limit);
      }

      const html = await response.text();
      const results: SearchResult[] = [];

      // Parse the lite HTML to extract results
      // DuckDuckGo lite format: <a class="result-link" href="...">title</a>
      // <td class="result-snippet">snippet</td>
      const linkRegex =
        /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
      const snippetRegex =
        /<td[^>]*class="result-snippet"[^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/td>/gi;

      let match;
      const links: { url: string; title: string }[] = [];

      while ((match = linkRegex.exec(html)) !== null && links.length < limit) {
        let url = match[1];
        const title = decodeHtmlEntities(match[2].trim());

        // DuckDuckGo URLs are often redirects, try to get the actual URL
        if (url.includes("uddg=")) {
          try {
            const urlParam = new URL(
              url,
              "https://duckduckgo.com",
            ).searchParams.get("uddg");
            if (urlParam) url = decodeURIComponent(urlParam);
          } catch {}
        }

        if (title && url && url.startsWith("http")) {
          links.push({ url, title });
        }
      }

      // Extract snippets
      const snippets: string[] = [];
      while ((match = snippetRegex.exec(html)) !== null) {
        snippets.push(stripHtml(match[1]).trim());
      }

      // Combine links with snippets
      links.forEach((link, index) => {
        results.push({
          source: "general",
          title: link.title,
          url: link.url,
          snippet: snippets[index] || "",
          score: 10 - index,
          metadata: { type: "web" },
        });
      });

      // If we got no results, try the instant answer API as fallback
      if (results.length === 0) {
        return this.searchDuckDuckGoInstant(query, limit);
      }

      return results;
    } catch (e) {
      console.error("[WebSearch] DuckDuckGo error:", e);
      // Fallback to instant answer API
      return this.searchDuckDuckGoInstant(query, limit);
    }
  }

  async searchDuckDuckGoInstant(
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    try {
      const response = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
        { signal: AbortSignal.timeout(this.timeout) },
      );

      if (!response.ok) return [];
      const data = await response.json();

      const results: SearchResult[] = [];

      // Instant answer
      if (data.Abstract) {
        results.push({
          source: "general",
          title: data.Heading || "Answer",
          url: data.AbstractURL || "",
          snippet: data.Abstract,
          score: 10,
          metadata: { type: "instant_answer" },
        });
      }

      // Related topics
      (data.RelatedTopics || []).slice(0, limit).forEach((topic: any) => {
        if (topic.Text && topic.FirstURL) {
          results.push({
            source: "general",
            title: topic.Text.split(" - ")[0],
            url: topic.FirstURL,
            snippet: topic.Text,
            score: 5,
            metadata: { type: "related" },
          });
        }
      });

      return results;
    } catch (e) {
      console.error("[WebSearch] DuckDuckGo Instant error:", e);
      return [];
    }
  }
}
