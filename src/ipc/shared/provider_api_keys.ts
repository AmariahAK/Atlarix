import { db } from "@/db";
import { providerApiKeys } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Get API key for a provider from local database
 * @param providerId Provider ID (e.g., 'openrouter', 'anthropic')
 * @returns API key if configured, undefined otherwise
 */
export async function getProviderApiKey(providerId: string): Promise<string | undefined> {
    const result = await db
        .select({ apiKey: providerApiKeys.apiKey })
        .from(providerApiKeys)
        .where(eq(providerApiKeys.providerId, providerId))
        .get();

    return result?.apiKey;
}

/**
 * Set API key for a provider
 * @param providerId Provider ID
 * @param apiKey API key to store
 */
export async function setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
    const existing = await db
        .select({ id: providerApiKeys.id })
        .from(providerApiKeys)
        .where(eq(providerApiKeys.providerId, providerId))
        .get();

    if (existing) {
        // Update existing key
        await db
            .update(providerApiKeys)
            .set({
                apiKey,
                updatedAt: new Date()
            })
            .where(eq(providerApiKeys.providerId, providerId));
    } else {
        // Insert new key
        await db.insert(providerApiKeys).values({
            providerId,
            apiKey,
        });
    }
    // PASS8 F2: configured-providers cache must be busted whenever the set changes.
    invalidateConfiguredProvidersCache();
}

/**
 * Delete API key for a provider
 * @param providerId Provider ID
 */
export async function deleteProviderApiKey(providerId: string): Promise<void> {
    await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, providerId));
    // PASS8 F2: configured-providers cache must be busted whenever the set changes.
    invalidateConfiguredProvidersCache();
}

// ═══════════════════════════════════════════════════════════════════
// PASS8 F2: configured-providers memo.
// ═══════════════════════════════════════════════════════════════════
// `provider:get-configured` is called from many UI paths (Settings,
// model picker, mode chooser, stream dispatch). Each call previously hit
// SQLite to read the providerApiKeys table. The result only changes when
// keys are inserted/updated/deleted via this module, so we cache it for
// the lifetime of the process and invalidate explicitly on mutation.
type ConfiguredProvidersCache = {
    value: string[];
    cachedAt: number;
};
let _configuredProvidersCache: ConfiguredProvidersCache | null = null;
/** Hard TTL safety net — also drops the cache if something writes to the table outside this module. */
const CONFIGURED_PROVIDERS_TTL_MS = 60_000;

export function invalidateConfiguredProvidersCache(): void {
    _configuredProvidersCache = null;
}

/**
 * Get all configured provider IDs (returns IDs only, not keys).
 * PASS8 F2: Result is memoized for `CONFIGURED_PROVIDERS_TTL_MS` and explicitly
 * busted by `setProviderApiKey` / `deleteProviderApiKey`.
 */
export async function getConfiguredProviders(): Promise<string[]> {
    const now = Date.now();
    if (
        _configuredProvidersCache &&
        now - _configuredProvidersCache.cachedAt < CONFIGURED_PROVIDERS_TTL_MS
    ) {
        return _configuredProvidersCache.value;
    }
    const results = await db
        .select({ providerId: providerApiKeys.providerId })
        .from(providerApiKeys);

    const value = results.map((r) => r.providerId);
    _configuredProvidersCache = { value, cachedAt: now };
    return value;
}
