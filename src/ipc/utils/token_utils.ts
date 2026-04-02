import { LargeLanguageModel } from "@/lib/schemas";
import { readSettings } from "../../main/settings";
import { Message } from "../ipc_types";

import { findLanguageModel } from "./findLanguageModel";

/** Chars per token heuristic (OpenAI-style rough estimate; not word count). */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Rough token count for budgeting prompts. Uses character length / 4 (ceiled), not word count.
 * Empty string → 0.
 */
export const estimateTokens = (text: string): number => {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN));
};

export const estimateMessagesTokens = (messages: Message[]): number => {
  return messages.reduce(
    (acc, message) => acc + estimateTokens(message.content),
    0,
  );
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

export async function getContextWindow() {
  const settings = readSettings();
  const modelOption = await findLanguageModel(settings.selectedModel);
  return modelOption?.contextWindow || DEFAULT_CONTEXT_WINDOW;
}

/** Effective budget: user override (if set) or model context window. Per-provider adaptive. */
export async function getEffectiveBudget(providerId: string): Promise<{
  budget: number;
  source: "model" | "override";
}> {
  if (providerId === "auto") {
    const budget = await getContextWindow();
    return { budget, source: "model" };
  }
  const settings = readSettings();
  const override = settings.tokenBudgetOverrides?.[providerId];
  if (override != null && override > 0) {
    return { budget: override, source: "override" };
  }
  const modelOption = await findLanguageModel(settings.selectedModel);
  const budget = modelOption?.contextWindow || DEFAULT_CONTEXT_WINDOW;
  return { budget, source: "model" };
}

export async function getMaxTokens(
  model: LargeLanguageModel,
): Promise<number | undefined> {
  const modelOption = await findLanguageModel(model);
  return modelOption?.maxOutputTokens ?? undefined;
}

/** When catalog has no max output, avoid tiny provider defaults that truncate mid-reply. */
const MAX_OUTPUT_TOKENS_FLOOR = 8192;

export async function getMaxTokensWithFloor(
  model: LargeLanguageModel,
): Promise<number> {
  const n = await getMaxTokens(model);
  return n ?? MAX_OUTPUT_TOKENS_FLOOR;
}

export async function getTemperature(
  model: LargeLanguageModel,
): Promise<number> {
  const modelOption = await findLanguageModel(model);
  return modelOption?.temperature ?? 0;
}
