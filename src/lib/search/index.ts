/**
 * Search Module
 * =============
 * 3-Tier smart search system for Atlarix
 * 
 * Tier 1: SearxNG (self-hosted) - Unlimited, best quality
 * Tier 2: Public SearxNG - Good quality, no setup
 * Tier 3: DDG Instant API - Default, always works
 */

export { searchDDGInstant } from './duckduckgo';
export {
    searchSearxng,
    searchPublicSearxng,
    getSearxngURL,
    isSearxngEnabled,
    PUBLIC_SEARXNG_INSTANCES,
    stripSiteOperators,
} from './searxng';

export interface UnifiedSearchResult {
    title: string;
    url: string;
    snippet: string;
    score: number;
    source: string;
    metadata?: Record<string, any>;
}

/**
 * Smart unified search - automatically selects best available source
 * Priority: SearxNG (self-hosted) > Public SearxNG > DDG Instant
 */
export async function smartSearch(
    query: string,
    limit: number = 10
): Promise<UnifiedSearchResult[]> {
    const { searchSearxng, searchPublicSearxng, stripSiteOperators } = await import('./searxng');
    const { searchDDGInstant } = await import('./duckduckgo');
    const { getSearxngConfig } = await import('./config');

    const stripped = stripSiteOperators(query).trim();
    const effectiveQuery = stripped.length > 0 ? stripped : query.trim();

    // Get unified config (works in both renderer and main process)
    const config = getSearxngConfig();
    console.log('[SmartSearch] Config:', config);

    // Tier 1: Self-hosted SearxNG
    if (config.enabled && config.url) {
        console.log('[SmartSearch] Using self-hosted SearxNG:', config.url);
        const results = await searchSearxng(effectiveQuery, undefined, limit, config.url);
        if (results.length > 0) {
            return results;
        }
        console.log('[SmartSearch] SearxNG returned 0 results, falling back...');
    }

    // Tier 2: Public SearxNG instances
    console.log('[SmartSearch] Trying public SearxNG instances');
    const publicResults = await searchPublicSearxng(effectiveQuery, undefined, limit);
    if (publicResults.length > 0) {
        return publicResults;
    }

    // Tier 3: DuckDuckGo Instant API (always works)
    console.log('[SmartSearch] Falling back to DDG Instant API');
    return searchDDGInstant(effectiveQuery, limit);
}
