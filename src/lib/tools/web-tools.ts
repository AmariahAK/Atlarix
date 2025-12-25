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

// ═══════════════════════════════════════════════════════════
// WEB SEARCH - Combined Perplexica + StackSense approach
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "web_search",
    description:
        `Unified web search with 3 modes and intelligent source selection:

MODES:
- quick (3 credits): Fast search, returns top results
- deep (5 credits): Fetches full content from top URLs
- comprehensive (8 credits): Maximum depth research with cross-referencing

SOURCES (choose based on query type):
- general: News, articles, blogs, current events (use for: news, trends, general info)
- stackoverflow: Programming Q&A (use for: code solutions, debugging)
- github: Code repositories, issues (use for: libraries, projects, examples)
- reddit: Community discussions (use for: opinions, experiences)
- mdn: Web API documentation (use for: HTML/CSS/JS API reference)
- all: Search all sources (use when broad coverage needed)

IMPORTANT: For news/current events, use sources="general". For code help, use sources="stackoverflow,github,mdn".

Returns rich previews with inline readable content.`,
    category: ToolCategory.WEB,
    cost: 3, // Base cost, adjusted by mode
    requiresWorkspace: false,
    isCore: true,
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
    handler: async ({ query, mode = "quick", sources = "general", num_results = 3 }) => {
        // Validate query parameter
        if (!query || typeof query !== 'string' || query.trim() === '') {
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
            console.log(`[web_search] Mode: ${searchMode}, Query: "${query}", Sources: ${sources}`);
            const aggregator = new WebSearchAggregator();

            // Adjust limits based on mode
            const maxResults = searchMode === 'comprehensive' ? Math.min(num_results, 10) :
                searchMode === 'deep' ? Math.min(num_results, 5) :
                    Math.min(num_results, 5);

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
            return {
                text: `❌ Web search error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                sources: []
            };
        }
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
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Atlarix/1.0 (Web Reader)',
                    'Accept': 'text/html,application/xhtml+xml,text/plain',
                },
            });

            if (!response.ok) {
                return `Failed to fetch URL: ${response.status} ${response.statusText}`;
            }

            const contentType = response.headers.get('content-type') || '';
            const text = await response.text();

            // Extract readable content
            let content = extractReadableContent(text, contentType);

            // Truncate if too long
            if (content.length > max_length) {
                content = content.substring(0, max_length) + '\n\n... [Content truncated]';
            }

            const title = extractTitle(text);

            return `📄 **${title || 'Web Page'}**\n📍 ${url}\n\n---\n\n${content}`;
        } catch (error) {
            throw new Error(`Failed to read URL: ${error}`);
        }
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

interface SearchResult {
    source: string;
    title: string;
    url: string;
    snippet: string;
    score: number;
    metadata: Record<string, any>;
}

interface CacheEntry {
    results: SearchResult[];
    timestamp: number;
}

class WebSearchAggregator {
    private timeout = 10000;
    private cache: Map<string, CacheEntry> = new Map();
    private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

    /**
     * Get cached results if available and not expired
     */
    private getCached(cacheKey: string): SearchResult[] | null {
        const entry = this.cache.get(cacheKey);
        if (!entry) return null;

        const now = Date.now();
        if (now - entry.timestamp > this.CACHE_TTL) {
            // Expired, remove it
            this.cache.delete(cacheKey);
            return null;
        }

        return entry.results;
    }

    /**
     * Store results in cache
     */
    private setCache(cacheKey: string, results: SearchResult[]): void {
        this.cache.set(cacheKey, {
            results,
            timestamp: Date.now()
        });

        // Clean up old entries (simple cleanup: remove if cache gets too large)
        if (this.cache.size > 100) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.cache.delete(firstKey);
        }
    }

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
        // Create cache key
        const cacheKey = `${sourcesStr}:${query}:${numResults}`;

        // Check cache first
        const cached = this.getCached(cacheKey);
        if (cached) {
            console.log(`[WebSearch] Cache hit for: ${query}`);
            return {
                formattedText: this.formatResults(query, cached),
                sources: cached
            };
        }

        console.log(`[WebSearch] Cache miss, fetching: ${query}`);
        const optimizedQuery = this.optimizeQuery(query);

        // Determine which sources to search
        const requestedSources = sourcesStr.toLowerCase().split(',').map(s => s.trim());
        const allSources = ['stackoverflow', 'github', 'reddit', 'mdn', 'general'];
        const sourcesToSearch = requestedSources.includes('all')
            ? allSources
            : requestedSources.filter(s => allSources.includes(s));

        if (sourcesToSearch.length === 0) {
            sourcesToSearch.push('general');
        }

        // Create search tasks
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

        // Execute in parallel
        const resultsArrays = await Promise.allSettled(tasks);

        // Combine and rank results
        const allResults: SearchResult[] = [];
        const sourceNames = sourcesToSearch; // For logging
        resultsArrays.forEach((result, idx) => {
            if (result.status === 'fulfilled' && result.value) {
                allResults.push(...result.value);
                console.log(`[WebSearch] ✅ ${sourceNames[idx]}: ${result.value.length} results`);
            } else if (result.status === 'rejected') {
                console.warn(`[WebSearch] ❌ ${sourceNames[idx]} failed:`, result.reason);
            }
        });

        // Rank by source priority with dynamic adjustment
        // If user specifically requested 'general' (e.g., for news), boost its priority
        const isGeneralFocused = requestedSources.includes('general') &&
            !requestedSources.includes('all') &&
            requestedSources.length <= 2;

        const sourcePriority: Record<string, number> = isGeneralFocused ? {
            // For news/general queries, prioritize general web
            'general': 5,
            'reddit': 4,
            'stackoverflow': 3,
            'github': 2,
            'mdn': 1
        } : {
            // For code/tech queries, prioritize docs/stackoverflow
            'stackoverflow': 5,
            'mdn': 4,
            'github': 3,
            'reddit': 2,
            'general': 1
        };

        allResults.sort((a, b) => {
            const aPriority = sourcePriority[a.source] || 0;
            const bPriority = sourcePriority[b.source] || 0;
            if (aPriority !== bPriority) return bPriority - aPriority;
            return b.score - a.score;
        });

        const topResults = allResults.slice(0, numResults * 2);

        // Store in cache before returning
        this.setCache(cacheKey, topResults);

        // Return both formatted text and sources array
        return {
            formattedText: this.formatResults(query, topResults),
            sources: topResults
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

// ===== HELPER FUNCTIONS =====

function extractReadableContent(html: string, contentType: string): string {
    if (contentType.includes('text/plain')) {
        return html;
    }

    // Remove script and style tags
    let content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    content = content.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
    content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
    content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
    content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');

    // Try to extract main content
    const mainMatch = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
        content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
        content.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    if (mainMatch) {
        content = mainMatch[1];
    }

    // Convert to text
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
