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
 * Set SearxNG URL in localStorage
 */
export function setSearxngURL(url: string): void {
    if (typeof window !== 'undefined') {
        localStorage.setItem(SEARXNG_URL_KEY, url);
    }
}

/**
 * Set SearxNG enabled state
 */
export function setSearxngEnabled(enabled: boolean): void {
    if (typeof window !== 'undefined') {
        localStorage.setItem(SEARXNG_ENABLED_KEY, String(enabled));
    }
}

/**
 * Get a random public instance
 */
export function getRandomPublicInstance(): string {
    const index = Math.floor(Math.random() * PUBLIC_SEARXNG_INSTANCES.length);
    return PUBLIC_SEARXNG_INSTANCES[index];
}

/**
 * Check if a SearxNG instance is healthy
 * Uses a simple search request instead of /config (which may have CORS issues)
 */
export async function checkSearxngHealth(url: string): Promise<boolean> {
    try {
        // Use search endpoint with a simple test query
        const response = await fetch(`${url}/search?q=test&format=json`, {
            signal: AbortSignal.timeout(8000),
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            console.log('[SearxNG] Health check failed:', response.status);
            return false;
        }

        // Verify we got valid JSON with results array
        const data = await response.json();
        const isValid = data && Array.isArray(data.results);
        console.log('[SearxNG] Health check:', isValid ? 'OK' : 'Invalid response');
        return isValid;
    } catch (e) {
        console.error('[SearxNG] Health check error:', e);
        return false;
    }
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
    // Determine which instance to use
    const instanceUrl = url || getSearxngURL();

    if (!instanceUrl) {
        console.log('[SearxNG] No instance configured, skipping');
        return [];
    }

    const cacheKey = `searxng:${instanceUrl}:${query}:${JSON.stringify(opts || {})}`;
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('[SearxNG] Cache hit for:', query);
        return cached.data.slice(0, limit);
    }

    try {
        console.log(`[SearxNG] Searching via ${instanceUrl}:`, query);

        const searchUrl = new URL(`${instanceUrl}/search`);
        searchUrl.searchParams.append('q', query);
        searchUrl.searchParams.append('format', 'json');

        // Apply options
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

        // Convert to standard SearchResult format
        const results: SearchResult[] = data.results.slice(0, limit).map((r, idx) => ({
            title: r.title || 'Untitled',
            url: r.url,
            snippet: r.content?.substring(0, 300) || '',
            // SearxNG provides internal scores, or we use position-based
            score: r.score ? r.score * 10 : (30 - idx),
            source: r.engine || 'searxng',
            metadata: {
                engines: r.engines,
                category: r.category,
                publishedDate: r.publishedDate
            }
        }));

        // Cache results
        cache.set(cacheKey, { data: results, timestamp: Date.now() });
        console.log(`[SearxNG] Found ${results.length} results for:`, query);

        return results;
    } catch (error) {
        console.error('[SearxNG] Search error:', error);
        return [];
    }
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
        } catch (e) {
            console.log(`[SearxNG] Public instance ${instance} failed, trying next...`);
        }
    }

    console.log('[SearxNG] All public instances failed');
    return [];
}

/**
 * Clear the SearxNG cache
 */
export function clearSearxngCache(): void {
    cache.clear();
    console.log('[SearxNG] Cache cleared');
}
