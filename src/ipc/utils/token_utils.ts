import { LargeLanguageModel } from "@/lib/schemas";
import { readSettings } from "../../main/settings";
import { Message } from "../ipc_types";

import { findLanguageModel } from "./findLanguageModel";
import { exactTokenCountText } from "@/lib/context/token-counter";
import {
  getCoreModelsDevTargetForTier,
  isCoreAutoTier,
} from "@/ipc/shared/compass_constants";
import { getModelsDevLimits } from "@/lib/models_dev";
import { supportsTemperatureParam } from "@/lib/routing/model-reasoning-profile";

/**
 * Token count using exact tokenizer.
 * Empty string → 0.
 */
export const estimateTokens = (text: string): number => {
  return exactTokenCountText(text);
};

export const estimateMessagesTokens = (messages: Message[]): number => {
  // W6 (v14.8.11): per-message sum, matching the context meter's scope — the
  // old role-joined exactTokenCount inflated counts with `role:` prefixes and
  // made the summarize nudge disagree with the meter (v14.8.5 #3).
  return messages.reduce(
    (acc, m) => acc + exactTokenCountText(m.content || ""),
    0,
  );
};

// v10.1: dead cache-aware usage helpers removed (normalizeTokenUsage,
// calculateBillableTokens, wouldOverflow, getUsableTokenBudget) — nothing
// consumed them; cache accounting lives in the stream onFinish handler.

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

export function setCompassContextWindow(
  chatId: number,
  contextWindow: number,
): void {
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
    // Before this chat's first TTFT capture, prefer the underlying tier model's
    // REAL context from models.dev (e.g. core-3 = 1M) over a blanket 200K —
    // otherwise the first turn over-prunes context. Keyed by the tier's provider +
    // vendor model id: the OpenRouter catalog this used to read knows nothing about
    // a vendor-native id, so a directly-routed tier silently got the 200K floor.
    if (isCoreAutoTier(target.name)) {
      const { autoContextWindow } = await import("@/lib/context/auto-context-window");
      const auto = await autoContextWindow().catch(() => null);
      if (auto) return { contextWindow: auto, source: "compass-fallback" };
    }
    const coreTarget = getCoreModelsDevTargetForTier(target.name);
    if (coreTarget) {
      const limits = await getModelsDevLimits(
        coreTarget.providerId,
        coreTarget.modelId,
      );
      if (limits?.context && limits.context > 0) {
        return { contextWindow: limits.context, source: "compass-fallback" };
      }
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
  // Core is a SYNTHETIC provider, and its registry entry carries a blanket
  // `maxOutputTokens: 32_000` (compass_constants). Nothing corrected it, because
  // `getLanguageModels` early-returns the synthetic list before
  // `enrichModelsWithModelsDevLimits` can run — so a 128K-output model was capped at a
  // quarter of its ceiling and long turns truncated for no reason anyone could see.
  //
  // Resolve the tier's REAL limit the same way `getContextWindowDetailed` above
  // resolves its context: by the tier's provider + vendor model id, which is the only
  // key models.dev answers to for a directly-routed tier.
  //
  // BYOK deliberately gets no equivalent here — it is already correct.
  // `enrichModelsWithModelsDevLimits` fills only MISSING limits and never overwrites a
  // provider's own value, and the floors below apply only on a total catalog miss.
  if (model.provider === "compass") {
    const coreTarget = getCoreModelsDevTargetForTier(model.name);
    if (coreTarget) {
      const limits = await getModelsDevLimits(
        coreTarget.providerId,
        coreTarget.modelId,
      );
      if (limits?.output && limits.output > 0) return limits.output;
    }
  }
  const modelOption = await findLanguageModel(model);
  return modelOption?.maxOutputTokens ?? undefined;
}

/** When catalog has no max output, avoid tiny provider defaults that truncate mid-reply. */
const MAX_OUTPUT_TOKENS_FLOOR = 8192;
/**
 * Reasoning models share `max_tokens` between reasoning and visible output, so on
 * a catalog miss (common for OpenRouter reasoning rows, which carry no output
 * limit) the 8192 floor can be spent on thinking and truncate the reply. Give
 * reasoning-capable models more headroom.
 */
const MAX_OUTPUT_TOKENS_FLOOR_REASONING = 32_000;

export async function getMaxTokensWithFloor(
  model: LargeLanguageModel,
  opts?: { reasoningCapable?: boolean },
): Promise<number> {
  const n = await getMaxTokens(model);
  if (n != null) return n;
  return opts?.reasoningCapable
    ? MAX_OUTPUT_TOKENS_FLOOR_REASONING
    : MAX_OUTPUT_TOKENS_FLOOR;
}

/**
 * Temperature to send, or undefined to OMIT the parameter entirely.
 *
 * Undefined is the meaningful case: some models reject `temperature` outright, and
 * kimi-k3 — a Core tier — is one of them (`temperature: false` in models.dev). Every
 * request has always carried `temperature: 0`, so those models were being sent a
 * parameter they don't accept.
 *
 * Models that DO accept it still get 0, unchanged, so this narrows behaviour to
 * exactly the models that need it rather than altering output everywhere.
 */
export async function getTemperature(
  model: LargeLanguageModel,
): Promise<number | undefined> {
  const providerId =
    model.provider === "compass"
      ? (getCoreModelsDevTargetForTier(model.name)?.providerId ??
        model.provider)
      : model.provider;
  const modelId =
    model.provider === "compass"
      ? (getCoreModelsDevTargetForTier(model.name)?.modelId ?? model.name)
      : model.name;
  if (!supportsTemperatureParam(providerId, modelId ?? "")) return undefined;
  const modelOption = await findLanguageModel(model);
  return modelOption?.temperature ?? 0;
}
