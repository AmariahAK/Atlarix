/**
 * Search Tools Handlers
 * =====================
 * IPC handlers for web search tools
 * These are called by the AI via tool calling
 */

import { duckDuckGoSearch, Source } from "../../lib/search/duckDuckGoSearch";
import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";

const logger = log.scope("search_tools");
const handle = createLoggedHandler(logger);

/**
 * Handle web search tool call
 * Searches the web using DuckDuckGo
 */
export async function handleWebSearch(params: {
    query: string;
    max_results?: number;
}): Promise<{
    sources: Source[];
    summary: string;
}> {
    const { query, max_results = 5 } = params;

    try {
        const results = await duckDuckGoSearch.search(query, max_results);
        const sources = duckDuckGoSearch.toSources(results);

        return {
            sources,
            summary: `Found ${results.length} results for "${query}"`
        };
    } catch (error) {
        console.error('Web search error:', error);
        return {
            sources: [],
            summary: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
    }
}

/**
 * Format search results as text for AI context
 * @param sources Search result sources
 * @returns Formatted string with search results
 */
export function formatSearchResults(sources: Source[]): string {
    if (sources.length === 0) {
        return "No results found.";
    }

    const formatted = sources.map((source, index) => {
        const lines = [
            `${index + 1}. **${source.title}**`,
            `   URL: ${source.url}`,
        ];

        if (source.content) {
            lines.push(`   ${source.content}`);
        }

        return lines.join('\n');
    });

    return [
        `## Web Search Results\n`,
        ...formatted,
        `\nTotal results: ${sources.length}`
    ].join('\n');
}

/**
 * Register search tool IPC handlers
 */
export function registerSearchToolsHandlers() {
    // Register web_search handler
    handle("web-search", async (_: any, params: { query: string; max_results?: number }) => {
        return await handleWebSearch(params);
    });
}
