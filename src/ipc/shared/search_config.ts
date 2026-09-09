/**
 * Search Config Database Helpers
 * ===============================
 * Database-backed search provider configuration (like provider_api_keys.ts)
 */

import { db } from "@/db";
import { searchProviders } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface SearchProviderConfig {
  url?: string;
  apiKey?: string;
}

export interface SearchProvider {
  provider: string;
  enabled: boolean;
  config: SearchProviderConfig | null;
  priority: number;
}

// In-memory cache with TTL
let configCache: { data: SearchProvider | null; timestamp: number } | null =
  null;
const CACHE_TTL = 60000; // 1 minute

/**
 * Invalidate the config cache (call when settings change)
 */
export function invalidateSearchConfigCache(): void {
  configCache = null;
  console.log("[SearchConfig] Cache invalidated");
}

/**
 * Get SearxNG configuration from database
 */
export async function getSearxngConfig(): Promise<SearchProvider | null> {
  // Check cache first
  const now = Date.now();
  if (configCache && now - configCache.timestamp < CACHE_TTL) {
    return configCache.data;
  }

  try {
    const result = await db
      .select()
      .from(searchProviders)
      .where(eq(searchProviders.provider, "searxng"))
      .get();

    if (!result) {
      configCache = { data: null, timestamp: now };
      return null;
    }

    const config: SearchProvider = {
      provider: result.provider,
      enabled: result.enabled ?? false,
      config: result.config as SearchProviderConfig | null,
      priority: result.priority ?? 0,
    };

    configCache = { data: config, timestamp: now };
    return config;
  } catch (error) {
    console.error("[SearchConfig] Error fetching config:", error);
    return null;
  }
}

/**
 * Set SearxNG configuration in database
 */
export async function setSearxngConfig(
  url: string,
  enabled: boolean,
): Promise<void> {
  const config: SearchProviderConfig = { url };

  const existing = await db
    .select({ id: searchProviders.id })
    .from(searchProviders)
    .where(eq(searchProviders.provider, "searxng"))
    .get();

  if (existing) {
    await db
      .update(searchProviders)
      .set({
        enabled,
        config,
        updatedAt: new Date(),
      })
      .where(eq(searchProviders.provider, "searxng"));
  } else {
    await db.insert(searchProviders).values({
      provider: "searxng",
      enabled,
      config,
      priority: 1, // Highest priority for self-hosted
    });
  }

  // Invalidate cache
  invalidateSearchConfigCache();
  console.log("[SearchConfig] SearxNG config saved:", { url, enabled });
}

/**
 * Delete SearxNG configuration from database
 */
export async function deleteSearxngConfig(): Promise<void> {
  await db
    .delete(searchProviders)
    .where(eq(searchProviders.provider, "searxng"));
  invalidateSearchConfigCache();
  console.log("[SearchConfig] SearxNG config deleted");
}
