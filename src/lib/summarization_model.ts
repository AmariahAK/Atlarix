/**
 * Resolve the model to use for summarization (compaction, titles).
 * Either the same model as the main chat, or an explicit custom model picked in
 * AI Configuration. (The old fast/balanced tiers were removed — a user who wants
 * a cheaper summarizer picks one explicitly via `customSummarizationModel`.)
 */

import type { LargeLanguageModel, UserSettings } from "./schemas";

/**
 * Returns the LargeLanguageModel to use for summarization and title generation.
 * "Same" is the TURN's model when the caller knows it (`turnModelForChat`): a
 * CLI, editor or user-agent session summarised with the app's choice sent its
 * conversation to a provider it never picked, and failed outright when that one
 * was unavailable (2026-10-20: "Atlarix Auto isn't offered right now" on /compact).
 */
export function getSummarizationModel(
  settings: UserSettings,
  turnModel?: LargeLanguageModel,
): {
  provider: string;
  name: string;
  customModelId?: number;
} {
  const cfg = settings.aiConfiguration?.contextSummarization;
  const mode = cfg?.summarizationModel ?? "same";
  if (mode === "custom" && cfg?.customSummarizationModel) {
    return cfg.customSummarizationModel;
  }
  return turnModel ?? settings.selectedModel;
}

/**
 * The model a chat's turns run on: its last request's own (the CLI's, an
 * editor's, a user agent's), else the app's. The same lookup a sub-agent uses
 * (run-subagent.ts).
 */
export async function turnModelForChat(
  chatId: number | null | undefined,
  settings: UserSettings,
): Promise<LargeLanguageModel> {
  if (chatId != null) {
    try {
      const { lastStreamRequest } = await import("@/ipc/handlers/chat_stream/stream-state");
      const own = lastStreamRequest.get(chatId)?.modelOverride;
      if (own) return own;
    } catch {
      /* no stream state in this process: the app's model */
    }
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

/** Compaction summarization: the turn's model (or the custom summarization model). */
export async function getCompactionSummarizationModel(
  settings: UserSettings,
  turnModel?: LargeLanguageModel,
): Promise<{ provider: string; name: string; customModelId?: number }> {
  return getSummarizationModel(settings, turnModel);
}
