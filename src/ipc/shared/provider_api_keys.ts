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
}

/**
 * Delete API key for a provider
 * @param providerId Provider ID
 */
export async function deleteProviderApiKey(providerId: string): Promise<void> {
    await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, providerId));
}

/**
 * Get all configured provider IDs (returns IDs only, not keys)
 * @returns Array of provider IDs that have API keys configured
 */
export async function getConfiguredProviders(): Promise<string[]> {
    const results = await db
        .select({ providerId: providerApiKeys.providerId })
        .from(providerApiKeys);

    return results.map((r) => r.providerId);
}
