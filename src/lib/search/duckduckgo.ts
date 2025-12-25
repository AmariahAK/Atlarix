/**
 * DuckDuckGo Search Client
 * =========================
 * Uses DDG Instant Answer API (no key required, safe, unlimited)
 * 
 * API docs: https://api.duckduckgo.com/api
 */

export interface DDGInstantResult {
    AbstractText: string;         // Summary text
    AbstractSource: string;       // Source name (e.g., "Wikipedia")
    AbstractURL: string;          // Source URL
    Answer: string;               // Direct answer (if available)
    AnswerType: string;           // Type of answer
    Definition: string;           // Definition (if applicable)
    DefinitionSource: string;     // Source of definition
    DefinitionURL: string;        // URL for definition
    Heading: string;              // Topic heading
    Image: string;                // Image URL
    ImageHeight: number;
    ImageWidth: number;
    Infobox: any;                 // Structured data
    Redirect: string;             // Redirect URL (for disambiguation)
    RelatedTopics: DDGRelatedTopic[];
    Results: DDGResult[];         // External links
    Type: string;                 // Response type: A (article), D (disambiguation), C (category), N (name), E (exclusive)
}

export interface DDGRelatedTopic {
    FirstURL: string;
    Icon: { URL: string; Height: number; Width: number } | null;
    Result: string;              // HTML formatted result
    Text: string;                // Plain text
}

export interface DDGResult {
    FirstURL: string;
    Icon: { URL: string; Height: number; Width: number } | null;
    Result: string;
    Text: string;
}

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    score: number;
    source: string;
    metadata?: Record<string, any>;
}

// Simple in-memory cache (5 minute TTL)
const cache = new Map<string, { data: SearchResult[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Search using DDG Instant Answer API
 * @param query Search query
 * @param limit Max results to return
 */
export async function searchDDGInstant(query: string, limit: number = 5): Promise<SearchResult[]> {
    const cacheKey = `ddg:${query}`;
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('[DDG] Cache hit for:', query);
        return cached.data.slice(0, limit);
    }

    try {
        console.log('[DDG] Fetching from Instant API:', query);

        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

        const response = await fetch(url, {
            signal: AbortSignal.timeout(10000),
            headers: {
                'User-Agent': 'Atlarix/1.0 (https://atlarix.dev)'
            }
        });

        if (!response.ok) {
            console.error('[DDG] API error:', response.status);
            return [];
        }

        const data: DDGInstantResult = await response.json();
        const results: SearchResult[] = [];
        let score = 30; // Base score for DDG results

        // 1. Main abstract (Wikipedia-style summary)
        if (data.AbstractText && data.AbstractURL) {
            results.push({
                title: data.Heading || 'Summary',
                url: data.AbstractURL,
                snippet: data.AbstractText.substring(0, 300),
                score: score--,
                source: 'duckduckgo',
                metadata: { type: 'abstract', from: data.AbstractSource }
            });
        }

        // 2. Direct answer
        if (data.Answer && data.AnswerType) {
            results.push({
                title: `Answer: ${data.Heading || query}`,
                url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
                snippet: data.Answer.substring(0, 300),
                score: score--,
                source: 'duckduckgo',
                metadata: { type: 'answer', answerType: data.AnswerType }
            });
        }

        // 3. Definition
        if (data.Definition && data.DefinitionURL) {
            results.push({
                title: `Definition: ${data.Heading || query}`,
                url: data.DefinitionURL,
                snippet: data.Definition.substring(0, 300),
                score: score--,
                source: 'duckduckgo',
                metadata: { type: 'definition', from: data.DefinitionSource }
            });
        }

        // 4. Related topics (good for exploring)
        for (const topic of data.RelatedTopics?.slice(0, 5) || []) {
            if (topic.FirstURL && topic.Text) {
                results.push({
                    title: extractTitleFromText(topic.Text),
                    url: topic.FirstURL,
                    snippet: topic.Text.substring(0, 300),
                    score: score--,
                    source: 'duckduckgo',
                    metadata: { type: 'related' }
                });
            }
        }

        // 5. External results
        for (const result of data.Results?.slice(0, 3) || []) {
            if (result.FirstURL && result.Text) {
                results.push({
                    title: extractTitleFromText(result.Text),
                    url: result.FirstURL,
                    snippet: result.Text.substring(0, 300),
                    score: score--,
                    source: 'duckduckgo',
                    metadata: { type: 'external' }
                });
            }
        }

        // Cache results
        cache.set(cacheKey, { data: results, timestamp: Date.now() });
        console.log(`[DDG] Found ${results.length} results for:`, query);

        return results.slice(0, limit);
    } catch (error) {
        console.error('[DDG] Search error:', error);
        return [];
    }
}

/**
 * Extract a title from DDG's text format (often "Title - Description")
 */
function extractTitleFromText(text: string): string {
    const dashIndex = text.indexOf(' - ');
    if (dashIndex > 0 && dashIndex < 100) {
        return text.substring(0, dashIndex);
    }
    return text.substring(0, 60) + (text.length > 60 ? '...' : '');
}

/**
 * Clear the DDG cache
 */
export function clearDDGCache(): void {
    cache.clear();
    console.log('[DDG] Cache cleared');
}
