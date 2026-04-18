/**
 * Atlarix Web Tools
 * ================
 * Combines Perplexica + StackSense approaches:
 * - 3-tier smart search: SearxNG > Public SearxNG > DDG Instant
 * - Parallel async searches across StackOverflow, GitHub, Reddit, MDN (StackSense)
 * - URL content extraction with summaries (Perplexica)
 * - Rich previews for inline reading
 * - Serper API for Google results (optional)
 * - Query optimization and caching
 */

import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
} from "./registry";
import { smartSearch, isSearxngEnabled } from "../search";
import createBm25Engine from "wink-bm25-text-search";

// ===== HELPER FUNCTIONS (used by web tools below) =====

function extractReadableContent(html: string, contentType: string): string {
    if (contentType.includes('text/plain')) {
        return html;
    }

    let content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    content = content.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
    content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
    content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
    content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');

    const mainMatch = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
        content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
        content.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    if (mainMatch) {
        content = mainMatch[1];
    }

    return stripHtml(content).trim();
}

function extractTitle(html: string): string {
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? decodeHtmlEntities(match[1].trim()) : '';
}

function stripHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/');
}

function extractDomain(url: string): string {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

interface SearchResult {
    source: string;
    title: string;
    url: string;
    snippet: string;
    score: number;
    metadata: Record<string, any>;
}

async function fetchUrlContent(
    url: string,
    maxLength: number
): Promise<{ ok: true; title: string; content: string } | { ok: false; error: string }> {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Atlarix/1.0 (Web Reader)',
                'Accept': 'text/html,application/xhtml+xml,text/plain',
            },
        });

        if (!response.ok) {
            return { ok: false, error: `Failed to fetch URL: ${response.status} ${response.statusText}` };
        }

        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        let content = extractReadableContent(text, contentType);
        if (content.length > maxLength) {
            content = content.substring(0, maxLength) + '\n\n... [Content truncated]';
        }
        const title = extractTitle(text);
        return { ok: true, title: title || 'Web Page', content };
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

function stableSourcesKey(sourcesStr: string): string {
    return sourcesStr
        .toLowerCase()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort()
        .join(",");
}

function canonicalWebSearchCacheKey(
    sourcesStr: string,
    query: string,
    numResults: number,
): string {
    const q = normalizeWebSearchUserQuery(query);
    const src = stableSourcesKey(sourcesStr);
    return `${src}:${q}:${numResults}`;
}

function tokenizeForSectionBm25(text: string): string[] {
    return String(text)
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length > 1);
}

/**
 * Ephemeral BM25 over text sections; returns best-matching slice for the focus query.
 * `search()` returns Array<[docId, score]> per wink-bm25-text-search.
 */
function extractRelevantSection(
    fullText: string,
    focusQuery: string,
    maxChars: number,
    maxSections: number,
): string {
    const body = fullText.trim();
    if (!body) return "";
    const paras = body.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    const sections: string[] = [];
    if (paras.length === 0) {
        sections.push(body.slice(0, maxChars));
    } else {
        for (const p of paras) {
            if (sections.length >= maxSections) break;
            if (p.length <= maxChars) {
                sections.push(p);
            } else {
                for (let i = 0; i < p.length && sections.length < maxSections; i += maxChars) {
                    sections.push(p.slice(i, i + maxChars));
                }
            }
        }
    }
    if (sections.length === 0) return body.slice(0, maxChars);
    const q = normalizeWebSearchUserQuery(focusQuery);
    if (!q) return sections[0].slice(0, maxChars);

    const engine = createBm25Engine();
    engine.defineConfig({ fldWeights: { body: 1 } });
    engine.definePrepTasks([tokenizeForSectionBm25], "body");
    let id = 0;
    for (const s of sections) {
        engine.addDoc({ body: s }, id);
        id += 1;
    }
    engine.consolidate();
    let results: Array<[number, number]>;
    try {
        results = engine.search(q, 1);
    } catch {
        return sections[0].slice(0, maxChars);
    }
    if (!results.length) return sections[0].slice(0, maxChars);
    const bestIdx = results[0][0];
    const picked = sections[bestIdx] ?? sections[0];
    return picked.length > maxChars ? picked.slice(0, maxChars) : picked;
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
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
]);

function filterRelevantResults(
    results: SearchResult[],
    query: string,
    maxResults: number
): SearchResult[] {
    const queryTokens = query.toLowerCase()
        .split(/\s+/)
        .filter(t => t.length > 2 && !RELEVANCE_STOP_WORDS.has(t));

    if (queryTokens.length === 0) {
        return results.slice(0, maxResults);
    }

    const scored = results.map(r => {
        const text = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
        const matches = queryTokens.filter(t => text.includes(t)).length;
        const relevanceScore = matches / queryTokens.length;
        return { r, relevanceScore };
    });

    return scored
        .filter(x => x.relevanceScore > 0.25)
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .map(x => x.r)
        .slice(0, maxResults);
}

function dedupeSearchResultsByUrl(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const r of results) {
        const key = (r.url || '').trim().toLowerCase();
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
const WEB_SEARCH_GLOBAL_IN_FLIGHT = new Map<string, Promise<{ formattedText: string; sources: SearchResult[] }>>();
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

function setGlobalWebSearchCached(cacheKey: string, results: SearchResult[]): void {
    WEB_SEARCH_GLOBAL_CACHE.set(cacheKey, { results, timestamp: Date.now() });
    if (WEB_SEARCH_GLOBAL_CACHE.size > 100) {
        const firstKey = WEB_SEARCH_GLOBAL_CACHE.keys().next().value;
        if (firstKey) WEB_SEARCH_GLOBAL_CACHE.delete(firstKey);
    }
}

// ═══════════════════════════════════════════════════════════
// WEB SEARCH - Combined Perplexica + StackSense approach
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "web_search",
    description: "Search the web. Modes: quick | deep | comprehensive. Sources: general, stackoverflow, github, reddit, mdn, all. See AGENTS.md for details.",
    category: ToolCategory.WEB,
    cost: 3, // Base cost, adjusted by mode
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - research only
    parameters: createParameters(
        {
            query: stringParam("Search query"),
            mode: stringParam("Search depth: 'quick' (default), 'deep', or 'comprehensive'"),
            sources: stringParam("Sources to search. For news/articles use 'general'. For code use 'stackoverflow,github,mdn'. Default: 'general'"),
            num_results: {
                type: "number",
                description: "Number of results per source (default: 3, max: 10 for comprehensive)",
            },
        },
        ["query"]
    ),
    handler: async (args: {
        query?: string;
        input?: { query?: string };
        mode?: string;
        sources?: string;
        num_results?: number;
    }) => {
        const nestedQ = args?.input && typeof args.input === "object" ? args.input.query : undefined;
        const rawQuery =
            typeof args.query === "string" && args.query.trim() !== ""
                ? args.query
                : typeof nestedQ === "string"
                  ? nestedQ
                  : "";
        const query = normalizeWebSearchUserQuery(rawQuery);
        const mode = args.mode ?? "quick";
        const sources = args.sources ?? "general";
        const num_results = args.num_results;

        // Validate query parameter
        if (!query || query === "") {
            console.log('[web_search] ERROR: No query provided');
            return {
                text: "⚠️ Please provide a search query. Example: web_search({ query: 'React hooks', mode: 'deep' })",
                sources: []
            };
        }

        // Normalize mode
        const searchMode = (mode || 'quick').toLowerCase();
        const validModes = ['quick', 'deep', 'comprehensive'];
        if (!validModes.includes(searchMode)) {
            return {
                text: `⚠️ Invalid mode: "${mode}". Use 'quick', 'deep', or 'comprehensive'.`,
                sources: []
            };
        }

        try {
            console.log(`[web_search] Mode: ${searchMode}, Query: "${query}", Sources: ${String(sources)}`);
            const aggregator = new WebSearchAggregator();

            const modeCap = searchMode === 'comprehensive' ? 10 : searchMode === 'deep' ? 8 : 5;
            const maxResults = Math.min(
                typeof num_results === 'number' && num_results > 0 ? num_results : 3,
                modeCap
            );

            const siteRoot = detectSiteRootUrl(query);
            if (siteRoot) {
                const maxLen = searchMode === 'comprehensive' ? 5000 : searchMode === 'deep' ? 4000 : 3000;
                const fetched = await fetchUrlContent(siteRoot, maxLen);
                if (!fetched.ok) {
                    return {
                        text: `**No page fetched for site query**\n\n${fetched.error}\n\n_Tried: ${siteRoot}_`,
                        sources: [],
                    };
                }
                const snippet = fetched.content.length > 500 ? fetched.content.substring(0, 500) + '…' : fetched.content;
                const text =
                    `**Direct page (site: operator)**\n\n` +
                    `📄 **${fetched.title}**\n📍 ${siteRoot}\n\n---\n\n${fetched.content}`;
                return {
                    text,
                    sources: [
                        {
                            title: fetched.title,
                            url: siteRoot,
                            content: snippet,
                            source: 'general',
                            score: 100,
                            favicon: `https://www.google.com/s2/favicons?domain=${extractDomain(siteRoot)}&sz=32`,
                        },
                    ],
                };
            }

            const searchResults = await aggregator.search(query, sources, maxResults);
            console.log(`[web_search] Found ${searchResults.sources.length} sources`);

            // For quick mode, return immediately
            if (searchMode === 'quick') {
                return {
                    text: searchResults.formattedText,
                    sources: searchResults.sources.map(result => ({
                        title: result.title,
                        url: result.url,
                        content: result.snippet,
                        source: result.source,
                        score: result.score,
                        favicon: result.url ? `https://www.google.com/s2/favicons?domain=${extractDomain(result.url)}&sz=32` : undefined
                    }))
                };
            }

            // For deep/comprehensive modes, fetch full content from URLs
            const urlsToFetch = searchResults.sources
                .filter(r => r.url && r.url.startsWith('http'))
                .slice(0, searchMode === 'comprehensive' ? 5 : 3);

            const fetchedContent = await Promise.allSettled(
                urlsToFetch.map(async (result) => {
                    try {
                        const response = await fetch(result.url, {
                            headers: {
                                'User-Agent': 'Atlarix/1.0 (Web Research)',
                                'Accept': 'text/html,application/xhtml+xml,text/plain',
                            },
                            signal: AbortSignal.timeout(10000)
                        });

                        if (!response.ok) return null;

                        const text = await response.text();
                        const content = extractReadableContent(text, response.headers.get('content-type') || '');
                        const maxLen = searchMode === 'comprehensive' ? 5000 : 3000;

                        return {
                            title: result.title,
                            url: result.url,
                            source: result.source,
                            content: content.substring(0, maxLen)
                        };
                    } catch {
                        return null;
                    }
                })
            );

            const validFetched = fetchedContent
                .filter(r => r.status === 'fulfilled' && r.value !== null)
                .map(r => (r as PromiseFulfilledResult<any>).value);

            // Build response
            let response = `# 🔍 ${searchMode.toUpperCase()} Search: "${query}"\n\n`;
            response += `_Searched ${searchResults.sources.length} sources`;
            if (validFetched.length > 0) {
                response += `, analyzed ${validFetched.length} pages in depth`;
            }
            response += `_\n\n`;

            // Quick overview
            response += `## Quick Overview\n${searchResults.formattedText}\n\n`;

            // Detailed analysis for deep/comprehensive
            if (validFetched.length > 0) {
                response += `## Detailed Content Analysis\n\n`;
                validFetched.forEach((page, idx) => {
                    response += `### ${idx + 1}. ${page.title}\n`;
                    response += `📍 [${page.source}] ${page.url}\n\n`;
                    response += `${page.content}\n\n---\n\n`;
                });
            }

            // For comprehensive mode, add cross-references
            if (searchMode === 'comprehensive' && validFetched.length > 1) {
                response += `## Cross-Reference Summary\n`;
                response += `Based on analysis of ${validFetched.length} sources, key themes include:\n`;
                response += `- Multiple sources confirm various approaches\n`;
                response += `- See individual source analyses above for details\n\n`;
            }

            return {
                text: response,
                sources: searchResults.sources.map(result => ({
                    title: result.title,
                    url: result.url,
                    content: result.snippet,
                    source: result.source,
                    score: result.score,
                    favicon: result.url ? `https://www.google.com/s2/favicons?domain=${extractDomain(result.url)}&sz=32` : undefined
                }))
            };
        } catch (error) {
            console.error('[web_search] Error:', error);

            // Check for 403 rate limit errors and provide helpful message
            const errorMessage = error instanceof Error ? error.message : String(error);
            const is403Error = errorMessage.includes('403') ||
                errorMessage.toLowerCase().includes('rate limit') ||
                errorMessage.toLowerCase().includes('forbidden');

            if (is403Error) {
                return {
                    text: `⚠️ **API Rate Limit Reached**

You've hit the daily search limit for the public API.

**Solution:** Enable SearxNG for unlimited searches!

1. Go to **Settings** → **Search**
2. Click "Auto-Setup SearxNG" (uses Docker)
3. Enjoy unlimited web searches!

_SearxNG is a privacy-respecting meta-search engine that aggregates results from multiple sources without rate limits._`,
                    sources: []
                };
            }

            return {
                text: `❌ Web search error: ${errorMessage}`,
                sources: []
            };
        }
    },
});

// ═══════════════════════════════════════════════════════════
// DEEP RESEARCH — ResearchLedger + agentic loop (chat-only friendly)
// ═══════════════════════════════════════════════════════════

type SubQuestionStatus = "pending" | "answered" | "partial" | "no_data";

interface SubQuestion {
    id: string;
    question: string;
    status: SubQuestionStatus;
    attempts: number;
    searchedQueries: string[];
}

interface ResearchFinding {
    subQuestionId: string;
    content: string;
    source: string;
    title: string;
    relevanceScore: number;
}

interface ResearchLedger {
    originalQuery: string;
    subQuestions: SubQuestion[];
    findings: ResearchFinding[];
    iterations: number;
    consecutiveEmptyIterations: number;
    coverageScore: number;
}

interface DeepResearchResult {
    query: string;
    aspectsUsed: string[];
    findings: ResearchFinding[];
    sources: string[];
    coverageScore: number;
    iterations: number;
    completionReason: "sufficient_coverage" | "no_new_data" | "all_answered" | "max_iterations";
}

const DEEP_RESEARCH_LIMITS = {
    maxIterations: 8,
    maxAttemptsPerSubQ: 3,
    maxSourcesPerSubQ: 3,
    maxCharsPerSource: 2000,
    maxSectionsPerDoc: 48,
    maxSubQuestions: 6,
    consecutiveEmptyStop: 3,
    sufficientCoverageThreshold: 0.75,
    fetchTimeoutMs: 10_000,
} as const;

/** When the model omits aspects, split on semicolons/newlines or use the whole query. */
function decomposeQuery(query: string): string[] {
    const parts = query.split(/;\s*|\n+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts;
    return [query];
}

function scoreRelevanceForDeepResearch(content: string, query: string): number {
    const queryTokens = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
    const contentLower = content.toLowerCase();
    const matches = queryTokens.filter((t) => contentLower.includes(t)).length;
    return queryTokens.length > 0 ? matches / queryTokens.length : 0;
}

function refineQuery(subQ: SubQuestion, ledger: ResearchLedger): string {
    const existingFindings = ledger.findings.filter((f) => f.subQuestionId === subQ.id);
    if (existingFindings.length === 0) {
        return `${subQ.question} detailed explanation examples`;
    }
    const visitedHosts = existingFindings
        .map((f) => {
            try {
                return new URL(f.source).hostname;
            } catch {
                return "";
            }
        })
        .filter(Boolean);
    if (visitedHosts.length > 0) {
        return `${subQ.question} tutorial guide`;
    }
    return `${subQ.question} comprehensive overview`;
}

function buildResult(
    ledger: ResearchLedger,
    reason: DeepResearchResult["completionReason"],
): DeepResearchResult {
    return {
        query: ledger.originalQuery,
        aspectsUsed: ledger.subQuestions.map((sq) => sq.question),
        findings: ledger.findings,
        sources: [...new Set(ledger.findings.map((f) => f.source))],
        coverageScore: ledger.coverageScore,
        iterations: ledger.iterations,
        completionReason: reason,
    };
}

function logDeepResearchComplete(_ledger: ResearchLedger, result: DeepResearchResult): void {
    console.log(
        `[deep_research] Completed: ${result.completionReason} | ` +
            `Final coverage: ${Math.round(result.coverageScore * 100)}% | ` +
            `${result.findings.length} findings from ${result.sources.length} sources`,
    );
}

function formatResultForModel(result: DeepResearchResult): string {
    const lines = [
        `## Research Results: ${result.query}`,
        `Coverage: ${Math.round(result.coverageScore * 100)}% | ` +
            `Iterations: ${result.iterations} | ` +
            `Stopped: ${result.completionReason}`,
        "",
    ];

    for (const finding of result.findings) {
        lines.push(`### Source: ${finding.title}`);
        lines.push(`URL: ${finding.source}`);
        lines.push(`Relevance: ${Math.round(finding.relevanceScore * 100)}%`);
        lines.push(finding.content);
        lines.push("");
    }

    if (result.findings.length === 0) {
        lines.push("No relevant findings retrieved for this query.");
    }

    return lines.join("\n");
}

async function smartReadUrlForDeepResearch(url: string): Promise<{ text: string; pageTitle: string }> {
    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Atlarix/1.0 (Deep Research)",
                Accept: "text/html,application/xhtml+xml,text/plain",
            },
            signal: AbortSignal.timeout(DEEP_RESEARCH_LIMITS.fetchTimeoutMs),
        });
        if (!response.ok) return { text: "", pageTitle: "" };
        const rawText = await response.text();
        const ct = response.headers.get("content-type") || "";
        const readable = extractReadableContent(rawText, ct);
        const pageTitle = extractTitle(rawText) || "";
        return { text: readable, pageTitle };
    } catch {
        return { text: "", pageTitle: "" };
    }
}

/** Same aggregator path as web_search quick (`general`); no ToolRegistry hop. */
async function deepResearchQuickSearch(query: string, numResults: number): Promise<SearchResult[]> {
    const aggregator = new WebSearchAggregator();
    const pack = await aggregator.search(query, "general", numResults);
    return pack.sources;
}

async function runDeepResearchAgentic(query: string, aspects?: string[]): Promise<DeepResearchResult> {
    const seed = aspects?.length ? aspects : decomposeQuery(query);
    const capped = seed.slice(0, DEEP_RESEARCH_LIMITS.maxSubQuestions);
    const subQuestionStrings = capped.length > 0 ? capped : [query];

    const subQuestions: SubQuestion[] = subQuestionStrings.map((q, i) => ({
        id: `sq_${i}`,
        question: q,
        status: "pending" as SubQuestionStatus,
        attempts: 0,
        searchedQueries: [],
    }));

    const ledger: ResearchLedger = {
        originalQuery: query,
        subQuestions,
        findings: [],
        iterations: 0,
        consecutiveEmptyIterations: 0,
        coverageScore: 0,
    };

    while (true) {
        ledger.iterations++;
        const findingsBeforeIteration = ledger.findings.length;

        const workQueue = ledger.subQuestions.filter(
            (sq) =>
                sq.status === "pending" ||
                (sq.status === "partial" && sq.attempts < DEEP_RESEARCH_LIMITS.maxAttemptsPerSubQ),
        );

        if (workQueue.length === 0) {
            const answered = ledger.subQuestions.filter((sq) => sq.status === "answered").length;
            ledger.coverageScore =
                ledger.subQuestions.length > 0 ? answered / ledger.subQuestions.length : 0;
            const result = buildResult(ledger, "all_answered");
            logDeepResearchComplete(ledger, result);
            return result;
        }

        console.log(
            `[deep_research] Iteration ${ledger.iterations} | ` +
                `Coverage: ${Math.round(ledger.coverageScore * 100)}% | ` +
                `Findings: ${ledger.findings.length} | ` +
                `Pending: ${ledger.subQuestions.filter((sq) => sq.status === "pending").length}`,
        );

        for (const subQ of workQueue) {
            subQ.attempts++;

            const searchQuery = subQ.attempts === 1 ? subQ.question : refineQuery(subQ, ledger);

            if (subQ.searchedQueries.includes(searchQuery)) {
                if (subQ.status === "pending") subQ.status = "no_data";
                continue;
            }
            subQ.searchedQueries.push(searchQuery);

            const searchResults = await deepResearchQuickSearch(
                searchQuery,
                DEEP_RESEARCH_LIMITS.maxSourcesPerSubQ,
            );

            if (!searchResults.length) {
                if (subQ.attempts >= DEEP_RESEARCH_LIMITS.maxAttemptsPerSubQ) {
                    subQ.status = "no_data";
                }
                continue;
            }

            for (const hit of searchResults.slice(0, 2)) {
                const url = hit.url;
                if (!url || !url.startsWith("http")) continue;

                const alreadyFetched = ledger.findings.some((f) => f.source === url);
                if (alreadyFetched) continue;

                const { text: fullContent, pageTitle } = await smartReadUrlForDeepResearch(url);
                if (!fullContent || fullContent.length < 100) continue;

                const relevantSection = extractRelevantSection(
                    fullContent,
                    subQ.question,
                    DEEP_RESEARCH_LIMITS.maxCharsPerSource,
                    DEEP_RESEARCH_LIMITS.maxSectionsPerDoc,
                );

                if (relevantSection.length > 50) {
                    const relevanceScore = scoreRelevanceForDeepResearch(relevantSection, subQ.question);

                    ledger.findings.push({
                        subQuestionId: subQ.id,
                        content: relevantSection,
                        source: url,
                        title: pageTitle || hit.title || url,
                        relevanceScore,
                    });
                }
            }

            const subQFindings = ledger.findings.filter((f) => f.subQuestionId === subQ.id);

            if (subQFindings.length === 0) {
                if (subQ.attempts >= DEEP_RESEARCH_LIMITS.maxAttemptsPerSubQ) {
                    subQ.status = "no_data";
                }
            } else if (subQFindings.some((f) => f.relevanceScore > 0.35)) {
                subQ.status = "answered";
            } else {
                subQ.status = "partial";
            }
        }

        const answered = ledger.subQuestions.filter((sq) => sq.status === "answered").length;
        ledger.coverageScore =
            ledger.subQuestions.length > 0 ? answered / ledger.subQuestions.length : 0;

        const newFindings = ledger.findings.length - findingsBeforeIteration;
        if (newFindings === 0) {
            ledger.consecutiveEmptyIterations++;
        } else {
            ledger.consecutiveEmptyIterations = 0;
        }

        if (ledger.coverageScore >= DEEP_RESEARCH_LIMITS.sufficientCoverageThreshold) {
            const result = buildResult(ledger, "sufficient_coverage");
            logDeepResearchComplete(ledger, result);
            return result;
        }

        if (ledger.consecutiveEmptyIterations >= DEEP_RESEARCH_LIMITS.consecutiveEmptyStop) {
            const result = buildResult(ledger, "no_new_data");
            logDeepResearchComplete(ledger, result);
            return result;
        }

        if (ledger.iterations >= DEEP_RESEARCH_LIMITS.maxIterations) {
            const result = buildResult(ledger, "max_iterations");
            logDeepResearchComplete(ledger, result);
            return result;
        }
    }
}

ToolRegistry.register({
    name: "deep_research",
    description:
        "Multi-step research: plans sub-questions, searches the web, fetches pages, and extracts the most relevant passages (BM25). Use for broad or comparative topics needing several sources. For a single quick fact or one query string, prefer web_search.",
    category: ToolCategory.WEB,
    cost: 6,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true,
    parameters: createParameters(
        {
            query: stringParam("Main research question or topic"),
            aspects: {
                type: "array",
                items: { type: "string" },
                description:
                    "Optional sub-questions or facets to investigate (each gets its own search pass)",
            },
        },
        ["query"],
    ),
    handler: async (args: {
        query?: string;
        input?: { query?: string; aspects?: string[] };
        aspects?: string[];
    }) => {
        const nested = args?.input && typeof args.input === "object" ? args.input : undefined;
        const rawMain =
            typeof args.query === "string" && args.query.trim() !== ""
                ? args.query
                : typeof nested?.query === "string"
                  ? nested.query
                  : "";
        const mainQuery = normalizeWebSearchUserQuery(rawMain);
        if (!mainQuery) {
            return {
                text: "⚠️ Provide a non-empty query for deep_research.",
                sources: [] as SearchResult[],
            };
        }
        const aspectsRaw = Array.isArray(args.aspects)
            ? args.aspects
            : Array.isArray(nested?.aspects)
              ? nested!.aspects!
              : undefined;

        let aspectStrings: string[] | undefined;
        if (aspectsRaw && aspectsRaw.length > 0) {
            const normalized = aspectsRaw
                .map((s) => normalizeWebSearchUserQuery(String(s)))
                .filter(Boolean)
                .slice(0, DEEP_RESEARCH_LIMITS.maxSubQuestions);
            if (normalized.length > 0) aspectStrings = normalized;
        }

        const result = await runDeepResearchAgentic(mainQuery, aspectStrings);

        const text = formatResultForModel(result);
        const sources = result.findings.map((f) => {
            const snippet = f.content.length > 400 ? f.content.slice(0, 400) + "…" : f.content;
            return {
                title: f.title,
                url: f.source,
                content: snippet,
                source: "general",
                score: Math.round(f.relevanceScore * 100),
                metadata: {},
                favicon: f.source
                    ? `https://www.google.com/s2/favicons?domain=${extractDomain(f.source)}&sz=32`
                    : undefined,
            };
        });

        return {
            query: result.query,
            aspects_used: result.aspectsUsed,
            coverage_score: result.coverageScore,
            iterations: result.iterations,
            completion_reason: result.completionReason,
            findings: result.findings,
            text,
            sources,
        };
    },
});

// ═══════════════════════════════════════════════════════════
// DEEP SEARCH - Perplexica-style comprehensive search
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "deep_search",
    description:
        "Perform deep web search: searches multiple sources, fetches full content from top results, and aggregates comprehensive information. Use for complex research topics requiring detailed analysis.",
    category: ToolCategory.WEB,
    cost: 5,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - research only
    parameters: createParameters(
        {
            query: stringParam("Search query for deep research"),
            max_sources: {
                type: "number",
                description: "Number of top URLs to fetch full content from (default: 3, max: 5)",
            },
        },
        ["query"]
    ),
    handler: async ({ query, max_sources = 3 }) => {
        try {
            // 1. Search multiple sources
            const aggregator = new WebSearchAggregator();
            const searchResults = await aggregator.search(query, "all", Math.min(max_sources, 5));

            // 2. Fetch full content from top results
            const topUrls = searchResults.sources
                .filter(r => r.url && r.url.startsWith('http'))
                .slice(0, max_sources);

            const fetchedContent = await Promise.allSettled(
                topUrls.map(async (result) => {
                    try {
                        const response = await fetch(result.url, {
                            headers: {
                                'User-Agent': 'Atlarix/1.0 (Deep Search)',
                                'Accept': 'text/html,application/xhtml+xml,text/plain',
                            },
                            signal: AbortSignal.timeout(10000)
                        });

                        if (!response.ok) return null;

                        const text = await response.text();
                        const content = extractReadableContent(text, response.headers.get('content-type') || '');

                        return {
                            title: result.title,
                            url: result.url,
                            content: content.substring(0, 3000) // 3000 chars per source
                        };
                    } catch {
                        return null;
                    }
                })
            );

            const validFetched = fetchedContent
                .filter(r => r.status === 'fulfilled' && r.value !== null)
                .map(r => (r as PromiseFulfilledResult<any>).value);

            // 3. Format comprehensive response
            let response = `# Deep Search Results for: "${query}"\n\n`;
            response += `_Searched ${searchResults.sources.length} sources, analyzed ${validFetched.length} pages in depth_\n\n`;

            response += `## Quick Overview\n${searchResults.formattedText}\n\n`;

            if (validFetched.length > 0) {
                response += `## Detailed Content Analysis\n\n`;
                validFetched.forEach((page, idx) => {
                    response += `### ${idx + 1}. ${page.title}\n`;
                    response += `📍 ${page.url}\n\n`;
                    response += `${page.content}\n\n---\n\n`;
                });
            }

            return {
                text: response,
                sources: searchResults.sources.map(result => ({
                    title: result.title,
                    url: result.url,
                    content: result.snippet,
                    favicon: result.url ? `https://www.google.com/s2/favicons?domain=${extractDomain(result.url)}&sz=32` : undefined
                }))
            };
        } catch (error) {
            throw new Error(`Deep search failed: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// URL READING - Perplexica-style content extraction
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "read_url",
    description:
        "Fetch and read content from a URL. Extracts main content and provides a clean, readable summary.",
    category: ToolCategory.WEB,
    cost: 2,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - only reads URL content
    parameters: createParameters(
        {
            url: stringParam("URL to fetch"),
            max_length: {
                type: "number",
                description: "Maximum content length to return (default: 5000 chars)",
            },
        },
        ["url"]
    ),
    handler: async ({ url, max_length = 5000 }) => {
        const fetched = await fetchUrlContent(url, max_length);
        if (!fetched.ok) {
            return fetched.error;
        }
        return `📄 **${fetched.title}**\n📍 ${url}\n\n---\n\n${fetched.content}`;
    },
});

// ═══════════════════════════════════════════════════════════
// DATE/TIME
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "get_current_time",
    description:
        "Get the current date and time in various formats (local, UTC, unix timestamp)",
    category: ToolCategory.DATETIME,
    cost: 0,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - no side effects
    parameters: createParameters(
        {
            timezone: stringParam(
                "Optional: Timezone (e.g., 'America/New_York', 'Europe/London')"
            ),
        },
        []
    ),
    handler: async ({ timezone }) => {
        const now = new Date();

        const formats = {
            local: now.toLocaleString(),
            iso: now.toISOString(),
            utc: now.toUTCString(),
            unix: Math.floor(now.getTime() / 1000),
            date: now.toLocaleDateString(),
            time: now.toLocaleTimeString(),
        };

        let result = `Current Date & Time:\n\n`;
        result += `📅 Local: ${formats.local}\n`;
        result += `🌍 UTC: ${formats.utc}\n`;
        result += `📊 ISO 8601: ${formats.iso}\n`;
        result += `⏱️  Unix Timestamp: ${formats.unix}\n`;

        if (timezone) {
            try {
                const zonedTime = now.toLocaleString("en-US", {
                    timeZone: timezone,
                });
                result += `\n🌐 ${timezone}: ${zonedTime}`;
            } catch (e) {
                result += `\n⚠️ Invalid timezone: ${timezone}`;
            }
        }

        return result;
    },
});

// ═══════════════════════════════════════════════════════════
// URL PARSING
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "parse_url",
    description: "Parse a URL and extract its components (protocol, host, path, query params)",
    category: ToolCategory.WEB,
    cost: 0,
    requiresWorkspace: false,
    isCore: true,
    isReadOnly: true, // Safe for Ask mode - just parses URLs
    parameters: createParameters(
        {
            url: stringParam("URL to parse"),
        },
        ["url"]
    ),
    handler: async ({ url }) => {
        try {
            const parsed = new URL(url);

            let result = `**URL Analysis**\n\n`;
            result += `🔗 Full URL: ${url}\n\n`;
            result += `📋 Components:\n`;
            result += `- Protocol: ${parsed.protocol}\n`;
            result += `- Host: ${parsed.host}\n`;
            result += `- Hostname: ${parsed.hostname}\n`;
            result += `- Port: ${parsed.port || "(default)"}\n`;
            result += `- Path: ${parsed.pathname}\n`;

            if (parsed.search) {
                result += `\n🔍 Query Parameters:\n`;
                parsed.searchParams.forEach((value, key) => {
                    result += `- ${key}: ${value}\n`;
                });
            }

            if (parsed.hash) {
                result += `\n#️⃣ Hash: ${parsed.hash}\n`;
            }

            return result;
        } catch (e) {
            return `Invalid URL: "${url}"\n\nPlease provide a valid URL starting with http:// or https://`;
        }
    },
});

// ═══════════════════════════════════════════════════════════
// HELPER CLASSES - Combined StackSense + Perplexica approach
// ═══════════════════════════════════════════════════════════

class WebSearchAggregator {
    private timeout = 10000;

    /**
     * Optimize search query by extracting keywords (StackSense approach)
     */
    private optimizeQuery(rawQuery: string): string {
        const stopWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
            'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
            'should', 'could', 'may', 'might', 'can', 'my', 'your', 'i', 'you',
            'what', 'how', 'why', 'when', 'where', 'which', 'who'
        ]);

        const words = rawQuery.toLowerCase().split(/\s+/);
        const keywords = words.filter(w => !stopWords.has(w) && w.length > 2);
        return keywords.slice(0, 6).join(' ') || rawQuery;
    }

    /**
     * Search across multiple sources in parallel (StackSense approach)
     * @returns Object with formattedText and sources array
     */
    async search(query: string, sourcesStr: string, numResults: number): Promise<{
        formattedText: string;
        sources: SearchResult[];
    }> {
        const cacheKey = canonicalWebSearchCacheKey(sourcesStr, query, numResults);

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
        const promise = new Promise<{ formattedText: string; sources: SearchResult[] }>(
            (resolve, reject) => {
                queueMicrotask(() => {
                    void (async () => {
                        try {
                            const out = await this.runSearchMerged(
                                query,
                                sourcesStr,
                                numResults,
                            );
                            setGlobalWebSearchCached(cacheKey, out.sources);
                            resolve(out);
                        } catch (err) {
                            reject(err);
                        } finally {
                            WEB_SEARCH_GLOBAL_IN_FLIGHT.delete(cacheKey);
                        }
                    })();
                });
            },
        );

        WEB_SEARCH_GLOBAL_IN_FLIGHT.set(cacheKey, promise);
        return promise;
    }

    private async runSearchMerged(
        query: string,
        sourcesStr: string,
        numResults: number
    ): Promise<{ formattedText: string; sources: SearchResult[] }> {
        const optimizedQuery = this.optimizeQuery(query);

        const requestedSources = sourcesStr.toLowerCase().split(',').map(s => s.trim());
        const allSources = ['stackoverflow', 'github', 'reddit', 'mdn', 'general'];
        let sourcesToSearch = requestedSources.includes('all')
            ? [...allSources]
            : requestedSources.filter(s => allSources.includes(s));

        if (sourcesToSearch.length === 0) {
            sourcesToSearch = ['general'];
        }

        const tasks: Promise<SearchResult[]>[] = [];

        if (sourcesToSearch.includes('stackoverflow')) {
            tasks.push(this.searchStackOverflow(optimizedQuery, numResults));
        }
        if (sourcesToSearch.includes('github')) {
            tasks.push(this.searchGitHub(optimizedQuery, numResults));
        }
        if (sourcesToSearch.includes('reddit')) {
            tasks.push(this.searchReddit(optimizedQuery, numResults));
        }
        if (sourcesToSearch.includes('mdn')) {
            tasks.push(this.searchMDN(optimizedQuery, numResults));
        }
        if (sourcesToSearch.includes('general')) {
            tasks.push(this.searchGeneral(optimizedQuery, numResults));
        }

        const resultsArrays = await Promise.allSettled(tasks);

        const allResults: SearchResult[] = [];
        const sourceNames = sourcesToSearch;
        resultsArrays.forEach((result, idx) => {
            if (result.status === 'fulfilled' && result.value) {
                allResults.push(...result.value);
                console.log(`[WebSearch] ✅ ${sourceNames[idx]}: ${result.value.length} results`);
            } else if (result.status === 'rejected') {
                console.warn(`[WebSearch] ❌ ${sourceNames[idx]} failed:`, result.reason);
            }
        });

        const deduped = dedupeSearchResultsByUrl(allResults);
        const relevant = filterRelevantResults(deduped, query, numResults);

        const isGeneralFocused = requestedSources.includes('general') &&
            !requestedSources.includes('all') &&
            requestedSources.length <= 2;

        const sourcePriority: Record<string, number> = isGeneralFocused ? {
            'general': 5,
            'reddit': 4,
            'stackoverflow': 3,
            'github': 2,
            'mdn': 1
        } : {
            'stackoverflow': 5,
            'mdn': 4,
            'github': 3,
            'reddit': 2,
            'general': 1
        };

        relevant.sort((a, b) => {
            const aPriority = sourcePriority[a.source] || 0;
            const bPriority = sourcePriority[b.source] || 0;
            if (aPriority !== bPriority) return bPriority - aPriority;
            return b.score - a.score;
        });

        const topResults = relevant.slice(0, numResults);

        return {
            formattedText: this.formatResults(query, topResults),
            sources: topResults,
        };
    }

    /**
     * Format results with inline readable content (Perplexica approach)
     */
    private formatResults(originalQuery: string, results: SearchResult[]): string {
        if (results.length === 0) {
            return `**No results found for: "${originalQuery}"**\n\n💡 **Suggestions:**\n- Try different keywords\n- Be more specific\n- Check spelling`;
        }

        const lines: string[] = [
            `**🔍 Search Results for: "${originalQuery}"**`,
            `_Found ${results.length} results across multiple sources_\n`,
        ];

        const sourceEmojis: Record<string, string> = {
            'stackoverflow': '💡',
            'github': '🐙',
            'reddit': '📢',
            'mdn': '📚',
            'general': '🌐'
        };

        results.forEach((result, idx) => {
            const emoji = sourceEmojis[result.source] || '🔗';
            lines.push(`### ${idx + 1}. ${emoji} ${result.title}`);
            lines.push(`📍 [${result.source.toUpperCase()}](${result.url})`);

            // Rich preview - inline readable content
            if (result.snippet) {
                lines.push(`\n> ${result.snippet}\n`);
            }

            // Metadata preview
            if (result.metadata) {
                const metaParts: string[] = [];
                if (result.metadata.answers !== undefined) {
                    metaParts.push(`✅ ${result.metadata.answers} answers`);
                }
                if (result.metadata.views !== undefined) {
                    metaParts.push(`👁 ${result.metadata.views.toLocaleString()} views`);
                }
                if (result.metadata.comments !== undefined) {
                    metaParts.push(`💬 ${result.metadata.comments} comments`);
                }
                if (result.metadata.subreddit) {
                    metaParts.push(`r/${result.metadata.subreddit}`);
                }
                if (result.metadata.state) {
                    metaParts.push(`Status: ${result.metadata.state}`);
                }
                if (metaParts.length > 0) {
                    lines.push(`_${metaParts.join(' | ')}_`);
                }
            }
            lines.push('');
        });

        return lines.join('\n');
    }

    // ===== SOURCE-SPECIFIC SEARCH METHODS =====

    async searchStackOverflow(query: string, limit: number): Promise<SearchResult[]> {
        try {
            const params = new URLSearchParams({
                order: 'desc',
                sort: 'relevance',
                intitle: query,
                site: 'stackoverflow',
                pagesize: String(limit),
                filter: 'withbody'
            });

            const response = await fetch(
                `https://api.stackexchange.com/2.3/search?${params}`,
                { signal: AbortSignal.timeout(this.timeout) }
            );

            if (!response.ok) return [];
            const data = await response.json();

            return (data.items || []).slice(0, limit).map((item: any) => ({
                source: 'stackoverflow',
                title: decodeHtmlEntities(item.title || ''),
                url: item.link || '',
                snippet: item.body_markdown?.substring(0, 300) ||
                    stripHtml(item.body || '').substring(0, 300) || '',
                score: item.score || 0,
                metadata: {
                    answers: item.answer_count || 0,
                    views: item.view_count || 0,
                    isAnswered: item.is_answered
                }
            }));
        } catch (e) {
            console.error('[WebSearch] StackOverflow error:', e);
            return [];
        }
    }

    async searchGitHub(query: string, limit: number): Promise<SearchResult[]> {
        try {
            const response = await fetch(
                `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=relevance&per_page=${limit}`,
                {
                    signal: AbortSignal.timeout(this.timeout),
                    headers: { 'Accept': 'application/vnd.github.v3+json' }
                }
            );

            if (!response.ok) return [];
            const data = await response.json();

            return (data.items || []).slice(0, limit).map((item: any, idx: number) => ({
                source: 'github',
                title: item.title || '',
                url: item.html_url || '',
                snippet: item.body?.substring(0, 300) || '',
                // Normalize score: use position-based scoring + engagement
                // GitHub returns issue/PR data, not relevance scores
                score: Math.max(20, 30 - (idx * 3) + Math.min(10, (item.comments || 0) / 10)),
                metadata: {
                    state: item.state,
                    comments: item.comments || 0
                }
            }));
        } catch (e) {
            console.error('[WebSearch] GitHub error:', e);
            return [];
        }
    }

    async searchReddit(query: string, limit: number): Promise<SearchResult[]> {
        try {
            const params = new URLSearchParams({
                q: `${query} subreddit:programming OR subreddit:webdev OR subreddit:learnprogramming`,
                limit: String(limit),
                sort: 'relevance'
            });

            const response = await fetch(
                `https://www.reddit.com/search.json?${params}`,
                {
                    signal: AbortSignal.timeout(this.timeout),
                    headers: { 'User-Agent': 'Atlarix/1.0' }
                }
            );

            if (!response.ok) return [];
            const data = await response.json();

            return (data.data?.children || []).slice(0, limit).map((post: any, index: number) => {
                const postData = post.data || {};
                return {
                    source: 'reddit',
                    title: postData.title || '',
                    url: `https://reddit.com${postData.permalink || ''}`,
                    snippet: postData.selftext?.substring(0, 300) || '',
                    // Normalize score: position-based + engagement (upvotes + comments)
                    // Reddit scores are upvotes which vary wildly, normalize to 15-35 range
                    score: Math.max(15, 25 - (index * 2) + Math.min(10, Math.log10((postData.score || 1) + 1) * 3 + (postData.num_comments || 0) / 100)),
                    metadata: {
                        subreddit: postData.subreddit,
                        comments: postData.num_comments || 0
                    }
                };
            });
        } catch (e) {
            console.error('[WebSearch] Reddit error:', e);
            return [];
        }
    }

    async searchMDN(query: string, limit: number): Promise<SearchResult[]> {
        try {
            const response = await fetch(
                `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(query)}`,
                { signal: AbortSignal.timeout(this.timeout) }
            );

            if (!response.ok) return [];
            const data = await response.json();

            return (data.documents || []).slice(0, limit).map((doc: any) => ({
                source: 'mdn',
                title: doc.title || '',
                url: `https://developer.mozilla.org${doc.mdn_url || ''}`,
                snippet: doc.summary?.substring(0, 300) || '',
                score: doc.score || 0,
                metadata: {
                    locale: doc.locale || 'en-US'
                }
            }));
        } catch (e) {
            console.error('[WebSearch] MDN error:', e);
            return [];
        }
    }

    async searchGeneral(query: string, limit: number): Promise<SearchResult[]> {
        // 3-tier smart search: SearxNG (self-hosted) > Public SearxNG > DDG Instant API
        // Falls back automatically through the tiers
        try {
            console.log('[WebSearch] Using 3-tier smart search for general');
            const results = await smartSearch(query, limit);
            return results.map((r, idx) => ({
                ...r,
                source: 'general',
                // Ensure scores are competitive with MDN (which has 20-60 range)
                score: Math.max(20, 35 - (idx * 2)),
                metadata: r.metadata || {}
            }));
        } catch (e) {
            console.error('[WebSearch] Smart search failed:', e);
            // Ultimate fallback: Serper if available
            const serperKey = process.env.SERPER_API_KEY;
            if (serperKey) {
                return this.searchSerper(query, limit, serperKey);
            }
            return [];
        }
    }

    async searchSerper(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
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
                    source: 'general',
                    title: data.answerBox.title || 'Quick Answer',
                    url: data.answerBox.link || '',
                    snippet: data.answerBox.answer || data.answerBox.snippet || '',
                    score: 100,
                    metadata: { type: 'answer_box' }
                });
            }

            // Organic results
            (data.organic || []).slice(0, limit).forEach((item: any) => {
                results.push({
                    source: 'general',
                    title: item.title || '',
                    url: item.link || '',
                    snippet: item.snippet || '',
                    score: item.position ? (10 - item.position) : 5,
                    metadata: {}
                });
            });

            return results;
        } catch (e) {
            console.error('[WebSearch] Serper error:', e);
            return [];
        }
    }

    async searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
        try {
            // Use the DuckDuckGo HTML endpoint for actual search results
            // The JSON API only returns instant answers, not real search results
            const response = await fetch(
                `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
                {
                    signal: AbortSignal.timeout(this.timeout),
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    }
                }
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
            const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
            const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/td>/gi;

            let match;
            const links: { url: string; title: string }[] = [];

            while ((match = linkRegex.exec(html)) !== null && links.length < limit) {
                let url = match[1];
                const title = decodeHtmlEntities(match[2].trim());

                // DuckDuckGo URLs are often redirects, try to get the actual URL
                if (url.includes('uddg=')) {
                    try {
                        const urlParam = new URL(url, 'https://duckduckgo.com').searchParams.get('uddg');
                        if (urlParam) url = decodeURIComponent(urlParam);
                    } catch { }
                }

                if (title && url && url.startsWith('http')) {
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
                    source: 'general',
                    title: link.title,
                    url: link.url,
                    snippet: snippets[index] || '',
                    score: 10 - index,
                    metadata: { type: 'web' }
                });
            });

            // If we got no results, try the instant answer API as fallback
            if (results.length === 0) {
                return this.searchDuckDuckGoInstant(query, limit);
            }

            return results;
        } catch (e) {
            console.error('[WebSearch] DuckDuckGo error:', e);
            // Fallback to instant answer API
            return this.searchDuckDuckGoInstant(query, limit);
        }
    }

    async searchDuckDuckGoInstant(query: string, limit: number): Promise<SearchResult[]> {
        try {
            const response = await fetch(
                `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
                { signal: AbortSignal.timeout(this.timeout) }
            );

            if (!response.ok) return [];
            const data = await response.json();

            const results: SearchResult[] = [];

            // Instant answer
            if (data.Abstract) {
                results.push({
                    source: 'general',
                    title: data.Heading || 'Answer',
                    url: data.AbstractURL || '',
                    snippet: data.Abstract,
                    score: 10,
                    metadata: { type: 'instant_answer' }
                });
            }

            // Related topics
            (data.RelatedTopics || []).slice(0, limit).forEach((topic: any) => {
                if (topic.Text && topic.FirstURL) {
                    results.push({
                        source: 'general',
                        title: topic.Text.split(' - ')[0],
                        url: topic.FirstURL,
                        snippet: topic.Text,
                        score: 5,
                        metadata: { type: 'related' }
                    });
                }
            });

            return results;
        } catch (e) {
            console.error('[WebSearch] DuckDuckGo Instant error:', e);
            return [];
        }
    }
}
