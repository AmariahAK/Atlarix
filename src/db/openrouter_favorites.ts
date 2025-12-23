/**
 * OpenRouter Favorites Management
 * Database operations for storing and retrieving user's favorite OpenRouter models
 */

import { eq, asc } from "drizzle-orm";
import { db } from "./index";
import { openrouterFavorites } from "./schema";

const MAX_FAVORITES = 7;

/**
 * Get all favorite OpenRouter model IDs in display order
 */
export async function getFavoriteOpenRouterModels(): Promise<string[]> {
    const favorites = await db
        .select({ modelId: openrouterFavorites.modelId })
        .from(openrouterFavorites)
        .orderBy(asc(openrouterFavorites.displayOrder))
        .all();

    return favorites.map((f) => f.modelId);
}

/**
 * Set favorite OpenRouter models
 * Replaces all existing favorites with the provided list
 * @param modelIds - Array of model IDs (max 7)
 */
export async function setFavoriteOpenRouterModels(modelIds: string[]): Promise<void> {
    if (modelIds.length > MAX_FAVORITES) {
        throw new Error(`Maximum ${MAX_FAVORITES} favorites allowed`);
    }

    // Delete all existing favorites
    await db.delete(openrouterFavorites).run();

    // Insert new favorites with display order
    if (modelIds.length > 0) {
        await db
            .insert(openrouterFavorites)
            .values(
                modelIds.map((modelId, index) => ({
                    modelId,
                    displayOrder: index + 1,
                }))
            )
            .run();
    }
}

/**
 * Add a favorite OpenRouter model
 * @param modelId - Model ID to add
 */
export async function addFavoriteOpenRouterModel(modelId: string): Promise<void> {
    const existing = await db
        .select({ id: openrouterFavorites.id })
        .from(openrouterFavorites)
        .all();

    if (existing.length >= MAX_FAVORITES) {
        throw new Error(`Maximum ${MAX_FAVORITES} favorites allowed`);
    }

    // Check if already favorited
    const alreadyFavorited = await db
        .select({ id: openrouterFavorites.id })
        .from(openrouterFavorites)
        .where(eq(openrouterFavorites.modelId, modelId))
        .get();

    if (alreadyFavorited) {
        return; // Already in favorites
    }

    // Add with next display order
    const nextOrder = existing.length + 1;
    await db
        .insert(openrouterFavorites)
        .values({
            modelId,
            displayOrder: nextOrder,
        })
        .run();
}

/**
 * Remove a favorite OpenRouter model
 * @param modelId - Model ID to remove
 */
export async function removeFavoriteOpenRouterModel(modelId: string): Promise<void> {
    await db.delete(openrouterFavorites).where(eq(openrouterFavorites.modelId, modelId)).run();

    // Reorder remaining favorites
    const remaining = await db
        .select({ id: openrouterFavorites.id, modelId: openrouterFavorites.modelId })
        .from(openrouterFavorites)
        .orderBy(asc(openrouterFavorites.displayOrder))
        .all();

    // Update display order
    for (let i = 0; i < remaining.length; i++) {
        await db
            .update(openrouterFavorites)
            .set({ displayOrder: i + 1 })
            .where(eq(openrouterFavorites.id, remaining[i].id))
            .run();
    }
}

/**
 * Check if a model is favorited
 * @param modelId - Model ID to check
 */
export async function isModelFavorited(modelId: string): Promise<boolean> {
    const result = await db
        .select({ id: openrouterFavorites.id })
        .from(openrouterFavorites)
        .where(eq(openrouterFavorites.modelId, modelId))
        .get();

    return result !== undefined;
}
