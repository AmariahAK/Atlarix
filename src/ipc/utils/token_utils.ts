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

// Fallback only — real limit fetched from provider per model.
// Models like Qwen3.5-Flash advertise 1M context; never cap them at 128K.
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Per-model context-window memo, keyed by `provider:name:customModelId`.
 * Populated lazily on the first lookup for each model id (live fetch via
 * `findLanguageModel`). Subsequent dispatches for the same model id hit
 * the cache — invalidation is implicit when the user changes models
 * (new key → new entry). Never cleared during a session.
 */
const contextWindowMemo = new Map<string, number>();

function contextWindowMemoKey(m: LargeLanguageModel): string {
  return `${m.provider}:${m.name}:${m.customModelId ?? ""}`;
}

/**
 * Per-chat live context window for Compass dispatches. Captured immediately
 * after the model emits its first chunk (`[TTFT]` log) — the underlying
 * OpenRouter model exposes its real context length there, which is what we
 * actually need to budget against. The OpenRouter registry lookup for
 * `compass/*` would otherwise return the abstraction limit (e.g. 128K),
 * not the real model limit (1M+ for Qwen-style models).
 */
const compassContextWindowByChat = new Map<number, number>();

export function setCompassContextWindow(chatId: number, contextWindow: number): void {
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    compassContextWindowByChat.set(chatId, contextWindow);
  }
}

export function getCompassContextWindow(chatId: number): number | undefined {
  return compassContextWindowByChat.get(chatId);
}

export function clearCompassContextWindow(chatId: number): void {
  compassContextWindowByChat.delete(chatId);
}

export type ContextWindowSource =
  | "live"
  | "cache"
  | "fallback"
  | "compass-live"
  | "compass-fallback";

/**
 * Resolve a model's true context window with source attribution.
 *   - "cache":            served from in-process memo (no disk/network I/O).
 *   - "live":             freshly resolved from the model registry / catalog.
 *   - "fallback":         resolution failed; using DEFAULT_CONTEXT_WINDOW.
 *   - "compass-live":     real per-chat value captured at TTFT for a Compass dispatch.
 *   - "compass-fallback": Compass model without a captured TTFT yet; using 200_000.
 *
 * `model` is optional and defaults to the user's `settings.selectedModel`,
 * which preserves backward compatibility for callers (e.g. proposal_handlers)
 * that don't yet pass an explicit `effectiveModel`.
 *
 * `chatId` is consulted only for `provider === "compass"`: Compass is an
 * abstraction whose registry entry has the wrong context length, so we must
 * use the live value the underlying model reports per stream.
 */
export async function getContextWindowDetailed(
  model?: LargeLanguageModel,
  chatId?: number,
): Promise<{ contextWindow: number; source: ContextWindowSource }> {
  const settings = readSettings();
  const target = model ?? settings.selectedModel;
  if (target.provider === "compass") {
    if (chatId != null) {
      const live = getCompassContextWindow(chatId);
      if (live) return { contextWindow: live, source: "compass-live" };
    }
    return { contextWindow: 200_000, source: "compass-fallback" };
  }
  const key = contextWindowMemoKey(target);
  const cached = contextWindowMemo.get(key);
  if (cached != null) {
    return { contextWindow: cached, source: "cache" };
  }
  const modelOption = await findLanguageModel(target);
  if (modelOption?.contextWindow && modelOption.contextWindow > 0) {
    contextWindowMemo.set(key, modelOption.contextWindow);
    return { contextWindow: modelOption.contextWindow, source: "live" };
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "fallback" };
}

export async function getContextWindow(
  model?: LargeLanguageModel,
  chatId?: number,
): Promise<number> {
  return (await getContextWindowDetailed(model, chatId)).contextWindow;
}

/** Effective budget: user override (if set) or the model's true context window.
 *
 * No provider is special-cased anymore — every non-`auto` provider routes
 * through `getContextWindow(selectedModel, chatId)`, which:
 *   - Memoizes per `provider:name:customModelId` so repeated lookups are free.
 *   - Falls back to `DEFAULT_CONTEXT_WINDOW` (200K) only when the live
 *     registry lookup fails, never to a per-provider hardcoded ceiling.
 *   - For Compass, consults `compassContextWindowByChat` (live TTFT capture)
 *     before the registry, so the budget reflects the underlying model's
 *     real ceiling (1M+ for Qwen-style models) instead of the synthetic
 *     `compass/*` abstraction limit.
 *
 * `chatId` only matters for Compass today, but is accepted for all providers
 * so future per-chat capture (e.g. OpenRouter "actual_context_length"
 * pass-through) can be wired without another signature change.
 */
export async function getEffectiveBudget(
  providerId: string,
  chatId?: number,
): Promise<{
  budget: number;
  source: "model" | "override";
}> {
  if (providerId === "auto") {
    const budget = await getContextWindow(undefined, chatId);
    return { budget, source: "model" };
  }
  const settings = readSettings();
  const override = settings.tokenBudgetOverrides?.[providerId];
  if (override != null && override > 0) {
    return { budget: override, source: "override" };
  }
  const budget = await getContextWindow(settings.selectedModel, chatId);
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
