/**
 * v2.1: Resolve the model to use for summarization (compaction, titles).
 * Fast (recommended) / same as main / custom per AI Configuration.
 * "Fast" uses the user's chosen fast model for the current provider (Auto first model, or first favorite for OpenRouter/Ollama/LM Studio).
 */

import type { UserSettings } from "./schemas";
import { getFastModelForCurrentProvider } from "../ipc/utils/get_model_client";

/**
 * Returns the LargeLanguageModel to use for summarization and title generation (sync).
 * For "fast" mode use getSummarizationModelAsync so the correct provider fast model is used.
 */
export function getSummarizationModel(settings: UserSettings): {
  provider: string;
  name: string;
  customModelId?: number;
} {
  const mode = settings.aiConfiguration?.contextSummarization?.summarizationModel ?? "fast";
  if (mode === "same") {
    return settings.selectedModel;
  }
  if (mode === "custom" && settings.aiConfiguration?.contextSummarization?.customSummarizationModel) {
    return settings.aiConfiguration.contextSummarization.customSummarizationModel;
  }
  return settings.selectedModel;
}

/**
 * Async version: when mode is "fast", uses the fast model for the current provider:
 * - Auto ON: first of the 3 Auto models (Fast) for the chosen provider (OpenAI, Anthropic, OpenRouter, etc.).
 * - Manual OpenRouter: first OpenRouter favorite.
 * - Manual Ollama / LM Studio: first favorite from provider settings.
 * - Manual other (OpenAI, Anthropic, Grok, etc.): selected model (no per-provider favorites in UI).
 */
export async function getSummarizationModelAsync(settings: UserSettings): Promise<{
  provider: string;
  name: string;
  customModelId?: number;
}> {
  const mode = settings.aiConfiguration?.contextSummarization?.summarizationModel ?? "fast";
  if (mode === "same") {
    return settings.selectedModel;
  }
  if (mode === "custom" && settings.aiConfiguration?.contextSummarization?.customSummarizationModel) {
    return settings.aiConfiguration.contextSummarization.customSummarizationModel;
  }
  if (mode === "fast") {
    let openRouterFavoriteIds: string[] | undefined;
    if (settings.selectedModel?.provider === "openrouter") {
      const { getFavoriteOpenRouterModels } = await import("../db/openrouter_favorites");
      openRouterFavoriteIds = await getFavoriteOpenRouterModels();
    }
    const fastModel = getFastModelForCurrentProvider(settings, openRouterFavoriteIds);
    if (fastModel) {
      return fastModel;
    }
  }
  return getSummarizationModel(settings);
}
