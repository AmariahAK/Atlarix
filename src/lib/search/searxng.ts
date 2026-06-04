/**
 * SearxNG Search Client
 * =====================
 * Connects to SearxNG metasearch engine (self-hosted or public instances)
 * 
 * SearxNG aggregates results from 70+ search engines including:
 * Google, Bing, DuckDuckGo, StackOverflow, Reddit, GitHub, Wikipedia, etc.
 */

export interface SearxngSearchOptions {
    categories?: string[];    // 'general', 'images', 'videos', 'news', 'music', 'files', 'it', 'science'
    engines?: string[];       // Specific engines: 'google', 'github', 'stackoverflow', etc.
    language?: string;        // Language code: 'en', 'de', 'fr', etc.
    pageno?: number;          // Page number (default: 1)
    time_range?: string;      // 'day', 'week', 'month', 'year'
    safesearch?: 0 | 1 | 2;   // 0=off, 1=moderate, 2=strict
}

export interface SearxngSearchResult {
    title: string;
    url: string;
    content?: string;         // Snippet/description
    engine: string;           // Which engine returned this
    engines?: string[];       // All engines that had this result
    score?: number;           // Relevance score
    category?: string;
    publishedDate?: string;
    img_src?: string;
    thumbnail_src?: string;
}

export interface SearxngResponse {
    results: SearxngSearchResult[];
    suggestions: string[];
    infoboxes?: any[];
    query: string;
    number_of_results?: number;
}

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    score: number;
    source: string;
    metadata?: Record<string, any>;
}

// Public SearxNG instances (curated, reliable)
// These can be used as fallback when no self-hosted instance is available
export const PUBLIC_SEARXNG_INSTANCES = [
    'https://searx.be',
    'https://search.disroot.org',
    'https://searx.tiekoetter.com',
    'https://priv.au',
    'https://search.sapti.me'
];

// Simple cache
const cache = new Map<string, { data: SearchResult[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Remove `site:…` tokens so engines receive a plain query (SearxNG mishandles site:). */
export function stripSiteOperators(query: string): string {
    return query.replace(/\bsite:[^\s]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

const HOST_CONCURRENCY_LIMIT = 2;
const HOST_MIN_GAP_MS = 500;

type HostSlotState = {
    active: number;
    waiters: Array<() => void>;
    lastEnd: number;
};

const hostSlotStates = new Map<string, HostSlotState>();

function getHostState(hostname: string): HostSlotState {
    let s = hostSlotStates.get(hostname);
    if (!s) {
        s = { active: 0, waiters: [], lastEnd: 0 };
        hostSlotStates.set(hostname, s);
    }
    return s;
}

async function acquireHostSlot(hostname: string): Promise<void> {
    const s = getHostState(hostname);
    if (s.active < HOST_CONCURRENCY_LIMIT) {
        s.active++;
        return;
    }
    await new Promise<void>(resolve => {
        s.waiters.push(() => {
            s.active++;
            resolve();
        });
    });
}

function releaseHostSlot(hostname: string): void {
    const s = hostSlotStates.get(hostname);
    if (!s) return;
    s.active--;
    const next = s.waiters.shift();
    if (next) next();
}

async function waitMinHostGap(hostname: string): Promise<void> {
    const s = getHostState(hostname);
    if (s.lastEnd <= 0) return;
    const gap = Math.max(0, HOST_MIN_GAP_MS - (Date.now() - s.lastEnd));
    if (gap > 0) {
        await new Promise<void>(r => setTimeout(r, gap));
    }
}

function markHostRequestEnd(hostname: string): void {
    const s = hostSlotStates.get(hostname);
    if (s) s.lastEnd = Date.now();
}

const inflightSearx = new Map<string, Promise<SearchResult[]>>();

// localStorage keys
const SEARXNG_URL_KEY = 'searxng_api_url';
const SEARXNG_ENABLED_KEY = 'searxng_enabled';

/**
 * Get the SearxNG URL from localStorage or environment
 */
export function getSearxngURL(): string | null {
    // Check localStorage first (user settings take priority)
    if (typeof window !== 'undefined') {
        const enabled = localStorage.getItem(SEARXNG_ENABLED_KEY);
        const url = localStorage.getItem(SEARXNG_URL_KEY);

        console.log('[SearxNG] localStorage check:', {
            enabled,
            url,
            windowDefined: typeof window !== 'undefined'
        });

        if (enabled === 'false') {
            console.log('[SearxNG] Explicitly disabled via localStorage');
            return null; // Explicitly disabled
        }

        if (url) {
            console.log('[SearxNG] Using localStorage URL:', url);
            return url.replace(/\/$/, ''); // Remove trailing slash
        }
    }

    // Fallback to environment variable (for server-side or CLI usage)
    const envUrl = typeof process !== 'undefined'
        ? process.env.SEARXNG_API_URL
        : null;

    if (envUrl) {
        console.log('[SearxNG] Using env var URL:', envUrl);
        return envUrl.replace(/\/$/, '');
    }

    console.log('[SearxNG] No URL configured');
    return null;
}

/**
 * Check if SearxNG is enabled
 */
export function isSearxngEnabled(): boolean {
    // Check if explicitly disabled
    if (typeof window !== 'undefined') {
        const enabled = localStorage.getItem(SEARXNG_ENABLED_KEY);
        if (enabled === 'false') {
            return false;
        }
    }
    const result = getSearxngURL() !== null;
    console.log('[SearxNG] isSearxngEnabled():', result);
    return result;
}

/**
 * Search using SearxNG
 * @param query Search query
 * @param url SearxNG instance URL (or uses env var / public instance)
 * @param opts Search options
 * @param limit Max results
 */
export async function searchSearxng(
    query: string,
    opts?: SearxngSearchOptions,
    limit: number = 10,
    url?: string
): Promise<SearchResult[]> {
    const instanceUrl = url || getSearxngURL();

    if (!instanceUrl) {
        console.log('[SearxNG] No instance configured, skipping');
        return [];
    }

    const stripped = stripSiteOperators(query);
    const qForRequest = stripped.length > 0 ? stripped : query.trim() || query;

    const cacheKey = `searxng:${instanceUrl}:${qForRequest}:${JSON.stringify(opts || {})}:${limit}`;
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('[SearxNG] Cache hit for:', qForRequest);
        return cached.data.slice(0, limit);
    }

    const existing = inflightSearx.get(cacheKey);
    if (existing) {
        const r = await existing;
        return r.slice(0, limit);
    }

    let hostname: string;
    try {
        hostname = new URL(instanceUrl).hostname;
    } catch {
        hostname = '_invalid_';
    }

    const promise = (async (): Promise<SearchResult[]> => {
        await acquireHostSlot(hostname);
        try {
            await waitMinHostGap(hostname);

            console.log(`[SearxNG] Searching via ${instanceUrl}:`, qForRequest);

            const searchUrl = new URL(`${instanceUrl}/search`);
            searchUrl.searchParams.append('q', qForRequest);
            searchUrl.searchParams.append('format', 'json');

            if (opts) {
                if (opts.categories) searchUrl.searchParams.append('categories', opts.categories.join(','));
                if (opts.engines) searchUrl.searchParams.append('engines', opts.engines.join(','));
                if (opts.language) searchUrl.searchParams.append('language', opts.language);
                if (opts.pageno) searchUrl.searchParams.append('pageno', String(opts.pageno));
                if (opts.time_range) searchUrl.searchParams.append('time_range', opts.time_range);
                if (opts.safesearch !== undefined) searchUrl.searchParams.append('safesearch', String(opts.safesearch));
            }

            const response = await fetch(searchUrl.toString(), {
                signal: AbortSignal.timeout(15000),
                headers: {
                    'User-Agent': 'Atlarix/1.0 (https://atlarix.dev)',
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                console.error('[SearxNG] API error:', response.status);
                return [];
            }

            const data: SearxngResponse = await response.json();

            const results: SearchResult[] = data.results.slice(0, limit).map((r, idx) => ({
                title: r.title || 'Untitled',
                url: r.url,
                snippet: r.content?.substring(0, 300) || '',
                score: r.score ? r.score * 10 : (30 - idx),
                source: r.engine || 'searxng',
                metadata: {
                    engines: r.engines,
                    category: r.category,
                    publishedDate: r.publishedDate
                }
            }));

            cache.set(cacheKey, { data: results, timestamp: Date.now() });
            console.log(`[SearxNG] Found ${results.length} results for:`, qForRequest);

            return results;
        } catch (error) {
            console.error('[SearxNG] Search error:', error);
            return [];
        } finally {
            markHostRequestEnd(hostname);
            releaseHostSlot(hostname);
        }
    })();

    inflightSearx.set(cacheKey, promise);
    promise.finally(() => {
        inflightSearx.delete(cacheKey);
    });

    const results = await promise;
    return results.slice(0, limit);
}

/**
 * Search using a public SearxNG instance (fallback)
 */
export async function searchPublicSearxng(
    query: string,
    opts?: SearxngSearchOptions,
    limit: number = 10
): Promise<SearchResult[]> {
    // Try public instances in order
    for (const instance of PUBLIC_SEARXNG_INSTANCES) {
        try {
            const results = await searchSearxng(query, opts, limit, instance);
            if (results.length > 0) {
                return results;
            }
        } catch {
            console.log(`[SearxNG] Public instance ${instance} failed, trying next...`);
        }
    }

    console.log('[SearxNG] All public instances failed');
    return [];
}

