/**
 * Resolve the model to use for summarization (compaction, titles).
 * Either the same model as the main chat, or an explicit custom model picked in
 * AI Configuration. (The old fast/balanced tiers were removed — a user who wants
 * a cheaper summarizer picks one explicitly via `customSummarizationModel`.)
 */

import type { UserSettings } from "./schemas";

/** Returns the LargeLanguageModel to use for summarization and title generation. */
export function getSummarizationModel(settings: UserSettings): {
  provider: string;
  name: string;
  customModelId?: number;
} {
  const cfg = settings.aiConfiguration?.contextSummarization;
  const mode = cfg?.summarizationModel ?? "same";
  if (mode === "custom" && cfg?.customSummarizationModel) {
    return cfg.customSummarizationModel;
  }
  return settings.selectedModel;
}

/**
 * Session stats are retained in the signature for caller compatibility but no
 * longer influence model choice (no balanced-tier escalation anymore).
 */
export interface SummarizationSessionStats {
  toolCallCount?: number;
  delegationCount?: number;
}

/** Async variant kept for callers; resolves the same way as the sync version. */
export async function getSummarizationModelAsync(
  settings: UserSettings,
  _sessionStats?: SummarizationSessionStats,
): Promise<{
  provider: string;
  name: string;
  customModelId?: number;
}> {
  return getSummarizationModel(settings);
}

/** Compaction summarization: use the selected (or custom) summarization model. */
export async function getCompactionSummarizationModel(
  settings: UserSettings,
): Promise<{ provider: string; name: string; customModelId?: number }> {
  return getSummarizationModel(settings);
}
