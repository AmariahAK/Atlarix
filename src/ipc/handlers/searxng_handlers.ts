/**
 * SearxNG IPC Handlers
 * ====================
 * Main process handlers for SearxNG requests (bypasses CORS)
 * Now uses database-backed storage (like OpenRouter API keys)
 */

import { ipcMain } from "electron";
import { setMainProcessConfig } from "../../lib/search/config";
import {
    getSearxngConfig,
    setSearxngConfig,
    deleteSearxngConfig,
    invalidateSearchConfigCache,
} from "../shared/search_config";

/**
 * Validate a SearxNG URL by attempting a test search
 */
async function validateSearxngUrl(url: string): Promise<{ valid: boolean; error?: string; resultsCount?: number }> {
    try {
        // Try /config endpoint first (lighter)
        try {
            const configResponse = await fetch(`${url}/config`, {
                signal: AbortSignal.timeout(5000),
                headers: { 'Accept': 'application/json' },
            });

            if (configResponse.ok) {
                return { valid: true, resultsCount: 0 };
            }
        } catch {
            // Config endpoint failed, try search
        }

        // Try search endpoint
        const response = await fetch(`${url}/search?q=test&format=json`, {
            signal: AbortSignal.timeout(8000),
            headers: { 'Accept': 'application/json' },
        });

        if (response.status === 403) {
            return {
                valid: false,
                error: "403 Forbidden - SearxNG bot protection is active. Disable limiter in settings.yml or use http://127.0.0.1:8080 instead of localhost."
            };
        }

        if (!response.ok) {
            return { valid: false, error: `HTTP ${response.status}` };
        }

        const data = await response.json();
        const isValid = data && Array.isArray(data.results);
        return { valid: isValid, resultsCount: data.results?.length || 0 };
    } catch (error: any) {
        if (error.name === 'TimeoutError') {
            return { valid: false, error: "Connection timeout - is SearxNG running?" };
        }
        return { valid: false, error: error.message || String(error) };
    }
}

/**
 * Search SearxNG with retry logic for 403 errors
 */
async function searchWithRetry(
    url: string,
    query: string,
    options?: {
        categories?: string[];
        engines?: string[];
        language?: string;
        pageno?: number;
    },
    retries: number = 2
): Promise<{ success: boolean; results?: any[]; suggestions?: string[]; error?: string }> {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
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
                headers: { 'Accept': 'application/json' },
                // No User-Agent to avoid bot detection
            });

            if (response.status === 403) {
                console.log(`[SearxNG] 403 on attempt ${attempt + 1}/${retries + 1}`);
                if (attempt < retries) {
                    // Exponential backoff
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                    continue;
                }
                return { success: false, error: "403 Forbidden - Rate limited or bot protection active" };
            }

            if (!response.ok) {
                return { success: false, error: `HTTP ${response.status}` };
            }

            const data = await response.json();
            console.log(`[SearxNG] Found ${data.results?.length || 0} results`);

            return {
                success: true,
                results: data.results || [],
                suggestions: data.suggestions || [],
            };
        } catch (error: any) {
            if (attempt === retries) {
                return { success: false, error: error.message || String(error) };
            }
        }
    }

    return { success: false, error: "Max retries exceeded" };
}

export function registerSearxngHandlers() {
    // Health check / validate URL
    ipcMain.handle("searxng:health-check", async (_, url: string) => {
        console.log("[SearxNG] Validating URL:", url);
        return await validateSearxngUrl(url);
    });

    // Validate URL (alias for health-check with better name)
    ipcMain.handle("searxng:validate-url", async (_, url: string) => {
        console.log("[SearxNG] Validating URL:", url);
        return await validateSearxngUrl(url);
    });

    // Search request with retry logic
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
        console.log(`[SearxNG] Searching: ${params.query}`);
        return await searchWithRetry(params.url, params.query, params.options);
    });

    // Get SearxNG config - with fallback for missing table
    ipcMain.handle("searxng:get-config", async () => {
        try {
            const config = await getSearxngConfig();
            console.log("[SearxNG] Get config from DB:", config);

            if (!config) {
                return { url: null, enabled: false };
            }

            const result = {
                url: config.config?.url || null,
                enabled: config.enabled,
            };

            // Also sync to in-memory config module for tools
            setMainProcessConfig(result);
            return result;
        } catch (error) {
            console.log("[SearxNG] DB read failed, returning default");
            return { url: null, enabled: false };
        }
    });

    // Set SearxNG config in database
    ipcMain.handle("searxng:set-config", async (_, config: { url: string | null; enabled: boolean }) => {
        console.log("[SearxNG] Set config:", config);

        // IMPORTANT: Update in-memory config FIRST so search works immediately
        // This ensures search tools can use the config even if DB fails
        setMainProcessConfig(config);

        // Then try to persist to database (may fail if migration not yet run)
        try {
            if (config.url && config.enabled) {
                await setSearxngConfig(config.url, true);
            } else if (config.url) {
                await setSearxngConfig(config.url, false);
            } else {
                await deleteSearxngConfig();
            }
            console.log("[SearxNG] Config persisted to database");
        } catch (error) {
            // Database may not have table yet - that's OK, in-memory config is set
            console.log("[SearxNG] DB persistence skipped (migration pending):", (error as Error).message);
        }

        return { success: true };
    });

    // Delete SearxNG config
    ipcMain.handle("searxng:delete-config", async () => {
        // Update in-memory first
        setMainProcessConfig({ url: null, enabled: false });

        // Then try database
        try {
            await deleteSearxngConfig();
        } catch (error) {
            console.log("[SearxNG] DB delete skipped (migration pending)");
        }

        return { success: true };
    });

    console.log("[SearxNG] IPC handlers registered (database-backed)");
}
