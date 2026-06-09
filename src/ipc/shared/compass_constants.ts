/**
 * Atlarix Core — managed provider (OpenRouter-backed, no user API key).
 * Model IDs come from build-time env: ATLARIX_CORE_MODEL_1..4.
 * All four Core models are available on every plan; access is metered strictly
 * by the shared Supabase token pool (`compass_tokens` table + RPCs — the
 * `compass` name is kept at the wire/storage layer for compatibility).
 */

import type { LanguageModel } from "../ipc_types";
import {
  formatModelApiNameForDisplay,
  formatModelWithProvider,
} from "@/lib/format-openrouter-model-label";
import { CORE_TIER_ROWS } from "../../shared/compass_product_copy";
import { getCoreModelOverrideId } from "./core-model-override-store";

export const COMPASS_PROVIDER_ID = "compass";

export const CORE_TIER_1 = "core-1";
export const CORE_TIER_2 = "core-2";
export const CORE_TIER_3 = "core-3";
export const CORE_TIER_4 = "core-4";

export const CORE_TIER_ORDER = [
  CORE_TIER_1,
  CORE_TIER_2,
  CORE_TIER_3,
  CORE_TIER_4,
] as const;

/** Pre-v11 persisted selections (`compass-*`) keep resolving forever. */
const LEGACY_COMPASS_TIER_ALIASES: Record<string, string> = {
  "compass-fast": CORE_TIER_1,
  "compass-balanced": CORE_TIER_2,
  "compass-thinking": CORE_TIER_3,
};

/** Map any internal/legacy tier id to its canonical `core-N` id (unknown ids pass through). */
export function normalizeCoreTierId(internalTierId: string): string {
  return LEGACY_COMPASS_TIER_ALIASES[internalTierId] ?? internalTierId;
}

export function isCoreTierId(internalTierId: string): boolean {
  return (CORE_TIER_ORDER as readonly string[]).includes(
    normalizeCoreTierId(internalTierId),
  );
}

function compassProviderSlug(openRouterModelId: string): string {
  if (!openRouterModelId.includes("/")) return "openrouter";
  return openRouterModelId.split("/")[0]?.toLowerCase() || "openrouter";
}

export const COMPASS_SYNTHETIC_MODELS: LanguageModel[] = CORE_TIER_ROWS.map(
  (row) => {
    const openRouterModelId = getOpenRouterModelIdForCoreTier(row.id)?.trim() ?? "";
    const modelDisplayName = openRouterModelId
      ? formatModelApiNameForDisplay(openRouterModelId)
      : row.id;
    const slug = openRouterModelId
      ? compassProviderSlug(openRouterModelId)
      : "openrouter";
    return {
    apiName: row.id,
    displayName: formatModelWithProvider(modelDisplayName, slug),
    description: row.description,
    type: "cloud" as const,
    dollarSigns: 0,
    maxOutputTokens: 32_000,
    // Core is a synthetic provider — the real context window is captured
    // per-chat at TTFT (often 1M+). 200_000 matches the pre-TTFT fallback in
    // `getContextWindowDetailed` so any catalog-only consumer (autorouter,
    // proposal handler) reads the same conservative ceiling the stream uses.
    contextWindow: 200_000,
  };
  },
);

/** Main-process only; renderer has no `process.env`. */
function trimEnv(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Read build-time Core env vars.
 * Must use static `process.env.*` property access so Vite `define` in
 * `vite.main.config.mts` can embed CI secrets into the packaged main bundle.
 */
function coreEnvAvailable(): boolean {
  return typeof process !== "undefined" && !!process.env;
}

export function getCompassMasterApiKey(): string | undefined {
  if (!coreEnvAvailable()) return undefined;
  return trimEnv(process.env.COMPASS_OPENROUTER_API_KEY);
}

export function getOpenRouterModelIdForCoreTier(
  internalTierId: string,
): string | undefined {
  const norm = normalizeCoreTierId(internalTierId);
  // Runtime override (hosted core-models.json) wins over the build-time env, so
  // Core models can change without repackaging. Null/absent → env fallback.
  const override = getCoreModelOverrideId(norm);
  if (override) return override;
  if (!coreEnvAvailable()) return undefined;
  switch (norm) {
    case CORE_TIER_1:
      return trimEnv(process.env.ATLARIX_CORE_MODEL_1);
    case CORE_TIER_2:
      return trimEnv(process.env.ATLARIX_CORE_MODEL_2);
    case CORE_TIER_3:
      return trimEnv(process.env.ATLARIX_CORE_MODEL_3);
    case CORE_TIER_4:
      return trimEnv(process.env.ATLARIX_CORE_MODEL_4);
    default:
      return undefined;
  }
}

/** True when the packaged app has Core credentials (counts as "configured" in Settings). */
export function isCompassBuildConfigured(): boolean {
  return !!getCompassMasterApiKey();
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
