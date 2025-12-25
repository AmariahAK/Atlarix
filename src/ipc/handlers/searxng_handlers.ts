/**
 * SearxNG IPC Handlers
 * ====================
 * Main process handlers for SearxNG requests (bypasses CORS)
 */

import { ipcMain } from "electron";
import { setMainProcessConfig } from "../../lib/search/config";

export function registerSearxngHandlers() {
    // Health check - runs in main process (no CORS)
    ipcMain.handle("searxng:health-check", async (_, url: string) => {
        try {
            console.log("[SearxNG] Main process health check:", url);

            // Try /config endpoint first as it's lighter and often allowed
            try {
                const configResponse = await fetch(`${url}/config`, {
                    signal: AbortSignal.timeout(5000),
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });

                if (configResponse.ok) {
                    console.log("[SearxNG] Health check (config) OK");
                    return { success: true, resultsCount: 0 };
                }
            } catch (e) {
                console.log("[SearxNG] Config check failed, trying search...");
            }

            // Fallback to search query
            const response = await fetch(`${url}/search?q=test&format=json`, {
                signal: AbortSignal.timeout(8000),
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            if (!response.ok) {
                console.log("[SearxNG] Health check failed:", response.status);
                // Return detailed error for 403
                if (response.status === 403) {
                    return { success: false, error: "403 Forbidden (Try using http://127.0.0.1:8080 or check LIMTTER/Bot settings)" };
                }
                return { success: false, error: `HTTP ${response.status}` };
            }

            const data = await response.json();
            const isValid = data && Array.isArray(data.results);
            console.log("[SearxNG] Health check:", isValid ? "OK" : "Invalid response");

            return { success: isValid, resultsCount: data.results?.length || 0 };
        } catch (error) {
            console.error("[SearxNG] Health check error:", error);
            return { success: false, error: String(error) };
        }
    });

    // Search request - runs in main process (no CORS)
    ipcMain.handle("searxng:search", async (_, params: {
        url: string;
        query: string;
        options?: {
            categories?: string[];
            engines?: string[];
            language?: string;
            pageno?: number;
        };
    }) => {
        try {
            const { url, query, options } = params;
            console.log(`[SearxNG] Main process search: ${query}`);

            const searchUrl = new URL(`${url}/search`);
            searchUrl.searchParams.append('q', query);
            searchUrl.searchParams.append('format', 'json');

            if (options) {
                if (options.categories) searchUrl.searchParams.append('categories', options.categories.join(','));
                if (options.engines) searchUrl.searchParams.append('engines', options.engines.join(','));
                if (options.language) searchUrl.searchParams.append('language', options.language);
                if (options.pageno) searchUrl.searchParams.append('pageno', String(options.pageno));
            }

            const response = await fetch(searchUrl.toString(), {
                signal: AbortSignal.timeout(15000),
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            if (!response.ok) {
                return { success: false, error: `HTTP ${response.status}` };
            }

            const data = await response.json();
            console.log(`[SearxNG] Found ${data.results?.length || 0} results`);

            return {
                success: true,
                results: data.results || [],
                suggestions: data.suggestions || []
            };
        } catch (error) {
            console.error("[SearxNG] Search error:", error);
            return { success: false, error: String(error) };
        }
    });

    // In-memory config storage for main process (since localStorage is browser-only)
    let searxngConfig = {
        url: process.env.SEARXNG_API_URL || null,
        enabled: false
    };

    // Get SearxNG config (for main process use)
    ipcMain.handle("searxng:get-config", async () => {
        console.log("[SearxNG] Main process get-config:", searxngConfig);
        return searxngConfig;
    });

    // Set SearxNG config (synced from renderer localStorage)
    ipcMain.handle("searxng:set-config", async (_, config: { url: string | null; enabled: boolean }) => {
        searxngConfig = config;
        console.log("[SearxNG] Main process config updated:", searxngConfig);
        return { success: true };
    });

    console.log("[SearxNG] IPC handlers registered");
}
