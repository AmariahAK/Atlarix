/**
 * v2.1: Resolve the model to use for summarization (compaction, titles).
 * Fast (recommended) / same as main / custom per AI Configuration.
 * "Fast" uses the user's chosen fast model for the current provider (Auto first model, or first favorite for OpenRouter/Ollama/LM Studio).
 */

import type { UserSettings } from "./schemas";
import { getFastModelForCurrentProvider, getBalancedModelForCurrentProvider } from "../ipc/utils/get_model_client";

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
 * v3.6: Session stats to prefer balanced model when complex (tool calls > 15 or delegations > 5).
 */
export interface SummarizationSessionStats {
  toolCallCount?: number;
  delegationCount?: number;
}

/**
 * Async version: when mode is "fast", uses the fast model for the current provider.
 * When session is complex (toolCallCount > 15 or delegationCount > 5), prefers balanced model for coherence.
 * - Auto ON: first of the 3 Auto models (Fast) or second (Balanced) when complex.
 * - Manual: first/second favorite when available.
 */
export async function getSummarizationModelAsync(
  settings: UserSettings,
  sessionStats?: SummarizationSessionStats
): Promise<{
  provider: string;
  name: string;
  customModelId?: number;
}> {
  const mode = settings.aiConfiguration?.contextSummarization?.summarizationModel ?? "balanced";
  if (mode === "same") {
    return settings.selectedModel;
  }
  if (mode === "custom" && settings.aiConfiguration?.contextSummarization?.customSummarizationModel) {
    return settings.aiConfiguration.contextSummarization.customSummarizationModel;
  }
  const preferBalanced =
    (sessionStats?.toolCallCount ?? 0) > 15 || (sessionStats?.delegationCount ?? 0) > 5;
  if ((mode === "balanced" || mode === "fast") && preferBalanced) {
    const balancedModel = getBalancedModelForCurrentProvider(settings);
    if (balancedModel) return balancedModel;
  }
  if (mode === "fast" || mode === "balanced") {
    const fastModel = getFastModelForCurrentProvider(settings);
    if (fastModel) return fastModel;
  }
  return getSummarizationModel(settings);
}

/**
 * Compaction summarization only: always prefer the fast tier model (ignore complex-session bump).
 */
export async function getCompactionSummarizationModel(
  settings: UserSettings,
): Promise<{ provider: string; name: string; customModelId?: number }> {
  const fast = getFastModelForCurrentProvider(settings);
  return fast ?? settings.selectedModel;
}
