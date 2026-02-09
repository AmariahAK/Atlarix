/**
 * v2.1: Resolve the model to use for summarization (compaction, titles).
 * Fast (recommended) / same as main / custom per AI Configuration.
 */

import type { UserSettings } from "./schemas";

/** Default fast model when summarizationModel is "fast" and no provider favorites. */
const DEFAULT_FAST_MODEL = { provider: "openrouter", name: "google/gemini-2.0-flash-exp:free" } as const;

/**
 * Returns the LargeLanguageModel to use for summarization and title generation.
 * Uses aiConfiguration.contextSummarization.summarizationModel: "fast" | "same" | "custom".
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
  // "fast" (default): use default fast model until per-provider Fast favorite is available
  return { ...DEFAULT_FAST_MODEL };
}
