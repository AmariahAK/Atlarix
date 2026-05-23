/**
 * Atlarix Compass — managed provider (OpenRouter-backed, no user API key).
 * Model IDs come from build-time env: COMPASS_MODEL_FAST, COMPASS_MODEL_BALANCED, COMPASS_MODEL_THINKING.
 */

import type { LanguageModel } from "../ipc_types";
import {
  formatModelApiNameForDisplay,
  formatModelWithProvider,
} from "@/lib/format-openrouter-model-label";
import { COMPASS_TIER_ROWS } from "../../shared/compass_product_copy";

export type CompassPlan = "free" | "pro" | "workforce";

export const COMPASS_PROVIDER_ID = "compass";

export const COMPASS_TIER_FAST = "compass-fast";
export const COMPASS_TIER_BALANCED = "compass-balanced";
export const COMPASS_TIER_THINKING = "compass-thinking";

export const COMPASS_TIER_ORDER = [
  COMPASS_TIER_FAST,
  COMPASS_TIER_BALANCED,
  COMPASS_TIER_THINKING,
] as const;

/** Main-process only; renderer has no `process.env`. */
function readCompassEnv(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export const COMPASS_SYNTHETIC_MODELS: LanguageModel[] = COMPASS_TIER_ROWS.map(
  (row) => {
    const openRouterModelId = getOpenRouterModelIdForCompassTier(row.id)?.trim() ?? "";
    const modelDisplayName = openRouterModelId
      ? formatModelApiNameForDisplay(openRouterModelId)
      : row.id;
    return {
    apiName: row.id,
    displayName: formatModelWithProvider(modelDisplayName, "openrouter"),
    description: row.description,
    type: "cloud" as const,
    dollarSigns: 0,
    maxOutputTokens: 32_000,
    // Compass is a synthetic provider — the real context window is captured
    // per-chat at TTFT (often 1M+). 200_000 matches the pre-TTFT fallback in
    // `getContextWindowDetailed` so any catalog-only consumer (autorouter,
    // proposal handler) reads the same conservative ceiling the stream uses.
    contextWindow: 200_000,
  };
  },
);

export function getCompassMasterApiKey(): string | undefined {
  return readCompassEnv("COMPASS_OPENROUTER_API_KEY");
}

export function getOpenRouterModelIdForCompassTier(
  internalTierId: string,
): string | undefined {
  const envMap: Record<string, string | undefined> = {
    [COMPASS_TIER_FAST]: readCompassEnv("COMPASS_MODEL_FAST"),
    [COMPASS_TIER_BALANCED]: readCompassEnv("COMPASS_MODEL_BALANCED"),
    [COMPASS_TIER_THINKING]: readCompassEnv("COMPASS_MODEL_THINKING"),
  };
  return envMap[internalTierId];
}

/** True when the packaged app has Compass credentials (counts as "configured" in Settings). */
export function isCompassBuildConfigured(): boolean {
  return !!getCompassMasterApiKey();
}

export function coerceCompassTierForPlan(
  requested: string,
  effectiveTier: CompassPlan,
): string {
  if (effectiveTier !== "free") {
    if (COMPASS_TIER_ORDER.includes(requested as (typeof COMPASS_TIER_ORDER)[number])) {
      return requested;
    }
    return COMPASS_TIER_FAST;
  }
  return COMPASS_TIER_FAST;
}

/** Fallback order: user's tier first, then remaining tiers in Fast → Balanced → Thinking order. */
export function compassFallbackChain(
  resolvedTier: string,
  effectiveTier: CompassPlan,
): string[] {
  const primary = coerceCompassTierForPlan(resolvedTier, effectiveTier);
  if (effectiveTier === "free") {
    return [COMPASS_TIER_FAST];
  }
  const start = COMPASS_TIER_ORDER.indexOf(
    primary as (typeof COMPASS_TIER_ORDER)[number],
  );
  const idx = start >= 0 ? start : 0;
  const rotated = [
    ...COMPASS_TIER_ORDER.slice(idx),
    ...COMPASS_TIER_ORDER.slice(0, idx),
  ];
  return [...new Set(rotated)];
}

export const COMPASS_REACHABILITY_ERROR =
  "We're currently having trouble reaching Atlarix Core. Please retry or switch to another provider in Settings.";

export function compassExhaustedUserMessage(tier: string): string {
  const t = (tier || "free").toLowerCase();
  if (t === "free") {
    return "Your Atlarix Core usage for this month is over. Upgrade to Pro or Workforce for more, or add your own API keys in Settings.";
  }
  if (t === "pro") {
    return "Your Atlarix Core usage for this month is over. Upgrade to Workforce for more, or add your own API keys in Settings.";
  }
  return "Your Atlarix Core usage for this month is over. Contact support@atlarix.dev for Pay-as-You-Go options, or add your own API keys in Settings.";
}
