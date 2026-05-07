import { LargeLanguageModel } from "@/lib/schemas";
import { readSettings } from "../../main/settings";
import { Message } from "../ipc_types";

import { findLanguageModel } from "./findLanguageModel";
import { exactTokenCountText, exactTokenCount } from "@/lib/context/token-counter";

/** Chars per token heuristic (OpenAI-style rough estimate; not word count). */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Token count using exact tokenizer.
 * Empty string → 0.
 */
export const estimateTokens = (text: string): number => {
  return exactTokenCountText(text);
};

export const estimateMessagesTokens = (messages: Message[]): number => {
  return exactTokenCount(messages.map(m => ({ role: m.role, content: m.content })));
};

/**
 * Token usage breakdown from AI SDK responses.
 * v7.1.2: Added cache token awareness for accurate overflow detection.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface TokenCountResult {
  /** Tokens counted for input (excludes cache) */
  billableInput: number;
  /** Tokens counted for output */
  output: number;
  /** Cache tokens (read + write) - not billed */
  cacheTokens: number;
  /** Total tokens including cache */
  total: number;
}

/**
 * Normalize AI SDK token usage to a consistent format.
 * v7.1.2: Properly handles cache token extraction from various provider formats.
 */
export function normalizeTokenUsage(raw: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
}): TokenUsage {
  const input = raw.inputTokens ?? 0;
  const cacheRead = raw.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = raw.inputTokenDetails?.cacheWriteTokens ?? 0;
  const output = raw.outputTokens ?? 0;
  const reasoning = raw.outputTokenDetails?.reasoningTokens ?? 0;

  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: raw.totalTokens ?? (input + output + cacheRead + cacheWrite),
  };
}

/**
 * Calculate billable vs cache tokens for cost tracking.
 * v7.1.2: Separates billable tokens from cache tokens for accurate accounting.
 */
export function calculateBillableTokens(usage: TokenUsage): TokenCountResult {
  const cacheTokens = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const billableInput = Math.max(0, usage.inputTokens - cacheTokens);
  const total = usage.totalTokens ?? (usage.inputTokens + usage.outputTokens);

  return {
    billableInput,
    output: usage.outputTokens,
    cacheTokens,
    total,
  };
}

/**
 * Check if tokens would cause overflow (OpenCode-style).
 * v7.1.2: Uses cache-aware token counting.
 */
export function wouldOverflow(
  usage: TokenUsage,
  usableBudget: number
): boolean {
  const { total } = calculateBillableTokens(usage);
  return total >= usableBudget;
}

/**
 * Get usable budget with cache awareness.
 * v7.1.2: Accounts for cache tokens in overflow calculation.
 */
export function getUsableTokenBudget(
  modelContextLimit: number,
  modelInputLimit: number | undefined,
  maxOutputTokens: number = 4000
): number {
  const COMPACTION_BUFFER = 20_000;
  const reserved = Math.min(COMPACTION_BUFFER, maxOutputTokens);
  return modelInputLimit
    ? Math.max(0, modelInputLimit - reserved)
    : Math.max(0, modelContextLimit - maxOutputTokens);
}

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

/**
 * Get max output tokens for a model (OpenCode-style).
 * v7.1.2: Mirrors OpenCode's ProviderTransform.maxOutputTokens.
 */
export async function getModelMaxOutputTokens(model: LargeLanguageModel): Promise<number> {
  const modelOption = await findLanguageModel(model);
  const output = modelOption?.maxOutputTokens;
  const EXPERIMENTAL_OUTPUT_TOKEN_MAX = 32_000;
  return Math.min(output ?? EXPERIMENTAL_OUTPUT_TOKEN_MAX, EXPERIMENTAL_OUTPUT_TOKEN_MAX) || EXPERIMENTAL_OUTPUT_TOKEN_MAX;
}

export async function getTemperature(
  model: LargeLanguageModel,
): Promise<number> {
  const modelOption = await findLanguageModel(model);
  return modelOption?.temperature ?? 0;
}
