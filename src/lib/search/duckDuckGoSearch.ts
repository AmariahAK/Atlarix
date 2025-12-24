/**
 * DuckDuckGo Search
 * =================
 * Simple web search using DuckDuckGo Instant Answers API
 * No API key required - completely free!
 * 
 * Based on StackSense implementation
 */

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface Source {
    title: string;
    url: string;
    content?: string;
    favicon?: string;
}

export class DuckDuckGoSearch {
    private readonly API_URL = "https://api.duckduckgo.com/";

    /**
     * Search the web using DuckDuckGo Instant Answers API
     * @param query Search query
     * @param maxResults Maximum number of results to return (default: 5)
     * @returns Array of search results
     */
    async search(query: string, maxResults: number = 5): Promise<SearchResult[]> {
        try {
            const params = new URLSearchParams({
                q: query,
                format: "json",
                no_html: "1",
                skip_disambig: "1"
            });

            const response = await fetch(`${this.API_URL}?${params}`, {
                headers: {
                    'User-Agent': 'Atlarix/1.0'
                }
            });

            if (!response.ok) {
                throw new Error(`DuckDuckGo API returned ${response.status}`);
            }

            const data = await response.json();
            const results: SearchResult[] = [];

            // Parse abstract (main result)
            if (data.AbstractText) {
                results.push({
                    title: data.Heading || "Result",
                    url: data.AbstractURL || "",
                    snippet: data.AbstractText.slice(0, 300)
                });
            }

            // Add related topics
            const relatedTopics = data.RelatedTopics || [];
            for (const topic of relatedTopics.slice(0, maxResults - 1)) {
                if (topic.Text && topic.FirstURL) {
                    // Extract title from text (before " - " separator)
                    const title = topic.Text.split(" - ")[0] || topic.Text.slice(0, 50);

                    results.push({
                        title: title,
                        url: topic.FirstURL,
                        snippet: topic.Text.slice(0, 200)
                    });
                }
            }

            return results.slice(0, maxResults);

        } catch (error) {
            console.error('DuckDuckGo search error:', error);
            // Return error as result so AI can see what happened
            return [{
                title: "Search Error",
                url: "",
                snippet: `Could not complete search: ${error instanceof Error ? error.message : 'Unknown error'}`
            }];
        }
    }

    /**
     * Convert search results to Source format for MessageSources component
     * @param results Search results from DuckDuckGo
     * @returns Array of sources with favicon URLs
     */
    toSources(results: SearchResult[]): Source[] {
        return results.map(result => ({
            title: result.title,
            url: result.url,
            content: result.snippet,
            favicon: result.url ? `https://www.google.com/s2/favicons?domain=${this.getDomain(result.url)}&sz=32` : undefined
        }));
    }

    /**
     * Extract domain from URL
     * @param url Full URL
     * @returns Domain name
     */
    private getDomain(url: string): string {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname.replace(/^www\./, '');
        } catch {
            return url;
        }
    }
}

// Export singleton instance
export const duckDuckGoSearch = new DuckDuckGoSearch();
