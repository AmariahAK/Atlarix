/**
 * OpenRouter Favorites IPC Handlers
 * Exposes favorite models management to the renderer process
 */

import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import {
    getFavoriteOpenRouterModels,
    setFavoriteOpenRouterModels,
    addFavoriteOpenRouterModel,
    removeFavoriteOpenRouterModel,
    isModelFavorited,
} from "../../db/openrouter_favorites";

const logger = log.scope("openrouter_favorites");
const handle = createLoggedHandler(logger);

export function registerOpenRouterFavoritesHandlers() {
    // Get all favorite models
    handle(
        "openrouter:get-favorites",
        async (): Promise<string[]> => {
            logger.log("Getting favorite OpenRouter models");
            const favorites = await getFavoriteOpenRouterModels();
            logger.log(`Found ${favorites.length} favorites`);
            return favorites;
        }
    );

    // Set favorite models (replaces all)
    handle(
        "openrouter:set-favorites",
        async (_, params: { modelIds: string[] }): Promise<void> => {
            logger.log(`Setting ${params.modelIds.length} favorite models`);
            await setFavoriteOpenRouterModels(params.modelIds);
            logger.log("Favorites updated successfully");
        }
    );

    // Add single favorite
    handle(
        "openrouter:add-favorite",
        async (_, params: { modelId: string }): Promise<void> => {
            logger.log(`Adding favorite: ${params.modelId}`);
            await addFavoriteOpenRouterModel(params.modelId);
            logger.log("Favorite added successfully");
        }
    );

    // Remove single favorite
    handle(
        "openrouter:remove-favorite",
        async (_, params: { modelId: string }): Promise<void> => {
            logger.log(`Removing favorite: ${params.modelId}`);
            await removeFavoriteOpenRouterModel(params.modelId);
            logger.log("Favorite removed successfully");
        }
    );

    // Check if model is favorited
    handle(
        "openrouter:is-favorited",
        async (_, params: { modelId: string }): Promise<boolean> => {
            const isFav = await isModelFavorited(params.modelId);
            logger.log(`Model ${params.modelId} favorited: ${isFav}`);
            return isFav;
        }
    );
}
