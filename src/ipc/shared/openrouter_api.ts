/**
 * OpenRouter API client for fetching available models
 * Filters for native tool-calling support
 */

interface OpenRouterModelResponse {
    data: OpenRouterModel[];
}

interface OpenRouterModel {
    id: string;
    name: string;
    description?: string;
    context_length: number;
    pricing: {
        prompt: string;
        completion: string;
    };
    supported_parameters?: string[];
    architecture?: {
        modality?: string;
        tokenizer?: string;
        instruct_type?: string;
    };
    top_provider?: {
        max_completion_tokens?: number;
    };
}

import type { LanguageModel } from '../ipc_types';
import { OPENROUTER_APP_HEADERS } from './openrouter_app_headers';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

interface CachedModels {
    models: LanguageModel[];
    timestamp: number;
}

let modelsCache: CachedModels | null = null;

/**
 * Fetches all available models from OpenRouter API
 * Filters for native tool-calling support
 * Caches results for 24 hours to avoid rate limiting
 */
export async function fetchOpenRouterModels(
    apiKey?: string
): Promise<LanguageModel[]> {
    // Check cache first
    if (modelsCache && Date.now() - modelsCache.timestamp < CACHE_DURATION) {
        // console.log('[OpenRouter] Returning cached models');
        return modelsCache.models;
    }

    try {
        // console.log('[OpenRouter] Fetching models from API...');

        const headers: Record<string, string> = {
            ...OPENROUTER_APP_HEADERS,
            'Content-Type': 'application/json',
        };

        // API key is optional for listing models
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await fetch(OPENROUTER_API_URL, { headers });

        if (!response.ok) {
            throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
        }

        const data: OpenRouterModelResponse = await response.json();
        // console.log(`[OpenRouter] Received ${data.data.length} total models`);

        // Filter for tool-calling models
        const toolCallingModels = data.data.filter((model, index) => {
            // Only check for tool support - modality check was too restrictive
            // OpenRouter returns "text->text", "text+image->text", etc - not just "text"
            const hasToolSupport =
                model.supported_parameters?.includes('tools') ||
                model.supported_parameters?.includes('function_calling');

            // Log first 5 models for debugging
            if (index < 5) {
                // console.log(`[OpenRouter] Model ${index}: ${model.id}`);
                // console.log(`  - modality: ${model.architecture?.modality}`);
                // console.log(`  - supported_parameters:`, model.supported_parameters);
                // console.log(`  - hasToolSupport: ${hasToolSupport}`);
            }

            return hasToolSupport;
        });

        // console.log(`[OpenRouter] Filtered to ${toolCallingModels.length} tool-calling models`);

        // Convert to LanguageModel format
        const languageModels: LanguageModel[] = toolCallingModels.map((model) => {
            const promptPrice = parseFloat(model.pricing.prompt || '0');
            const isFree = promptPrice === 0;

            return {
                apiName: model.id,
                displayName: model.name,
                description: model.description || '',
                contextWindow: model.context_length,
                maxOutputTokens: model.top_provider?.max_completion_tokens,
                dollarSigns: isFree ? 0 : 1,
                type: 'cloud',
                supportsToolChoice: true,
            };
        });

        // Update cache
        modelsCache = {
            models: languageModels,
            timestamp: Date.now(),
        };

        return languageModels;
    } catch (error) {
        console.error('[OpenRouter] Failed to fetch models:', error);

        // Return cached models if available, even if expired
        if (modelsCache) {
            console.log('[OpenRouter] Returning expired cache due to error');
            return modelsCache.models;
        }

        // Return empty array if no cache available
        return [];
    }
}

/**
 * Invalidates the models cache
 * Useful for forcing a refresh
 */
export function invalidateModelsCache(): void {
    modelsCache = null;
    console.log('[OpenRouter] Models cache invalidated');
}

/**
 * Gets cached models without fetching
 * Returns null if no cache available
 */
export function getCachedModels(): LanguageModel[] | null {
    if (!modelsCache) return null;
    return modelsCache.models;
}
