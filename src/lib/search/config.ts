/**
 * SearxNG Config Bridge
 * =====================
 * Provides access to SearxNG config in both renderer and main process
 */

// Main process config (shared across all main process code)
let mainProcessConfig: { url: string | null; enabled: boolean } = {
    url: typeof process !== 'undefined' ? (process.env.SEARXNG_API_URL || null) : null,
    enabled: false
};

/**
 * Get SearxNG config - works in both renderer and main process
 */
export function getSearxngConfig(): { url: string | null; enabled: boolean } {
    // Renderer process - read from localStorage
    if (typeof window !== 'undefined') {
        const url = localStorage.getItem('searxng_api_url');
        const enabled = localStorage.getItem('searxng_enabled');

        return {
            url: enabled === 'false' ? null : (url || null),
            enabled: enabled !== 'false' && url !== null
        };
    }

    // Main process - read from in-memory config
    return mainProcessConfig;
}

/**
 * Set SearxNG config (main process only - called by IPC handler)
 */
export function setMainProcessConfig(config: { url: string | null; enabled: boolean }): void {
    mainProcessConfig = config;
    console.log('[SearxNG Config] Main process config updated:', mainProcessConfig);
}
