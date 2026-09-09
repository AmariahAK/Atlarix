/**
 * SearxNG Config Bridge
 * =====================
 * Provides access to SearxNG config in both renderer and main process
 *
 * Main process: Reads from database via search_config.ts
 * Renderer: Uses IPC to get config from main process
 */

// In-memory cache for main process (synced from IPC handler)
let mainProcessConfig: { url: string | null; enabled: boolean } = {
  url: null,
  enabled: false,
};

/**
 * Get SearxNG config - works in both renderer and main process
 *
 * Main process: Returns cached config (updated by IPC handlers)
 * Renderer: Should use IPC directly (this is a fallback)
 */
export function getSearxngConfig(): { url: string | null; enabled: boolean } {
  // In renderer, this will return the cached config
  // The config should be synced on app startup and when settings change
  return mainProcessConfig;
}

/**
 * Set SearxNG config (main process only - called by IPC handler)
 * This updates the in-memory cache that tools use
 */
export function setMainProcessConfig(config: {
  url: string | null;
  enabled: boolean;
}): void {
  mainProcessConfig = config;
  console.log(
    "[SearxNG Config] Main process config updated:",
    mainProcessConfig,
  );
}
