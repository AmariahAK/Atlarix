/**
 * Atlarix Core — managed provider (no user API key). Requests go to the Core proxy,
 * which forwards to the provider clouds directly on keys held server-side.
 * Model IDs come from build-time env: ATLARIX_CORE_MODEL_1..4.
 * All four Core models are available on every plan; usage is billed via the
 * pay-as-you-go credit wallet — the proxy meters real cost behind a per-call
 * reserve gate (the `compass` name is kept at the wire/storage layer for
 * compatibility).
 */

import type { LanguageModel } from "../ipc_types";
import {
  formatModelApiNameForDisplay,
  formatModelWithProvider,
} from "@/lib/format-openrouter-model-label";
import { CORE_TIER_ROWS } from "../../shared/compass_product_copy";
import {
  getCoreModelOverrideId,
  getCoreTierRouting,
} from "./core-model-override-store";
import { getCoreProxyBaseUrl } from "./core_proxy";

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

/**
 * Build the four synthetic Core models for display/selection.
 *
 * Computed lazily (NOT a module-level const) so the display name + provider
 * slug always reflect the CURRENT runtime override (hosted `core-models.json`).
 * A const snapshot would freeze to the build-time env at import time and never
 * pick up a `core-models.json` change without an app restart.
 */
export function getCompassSyntheticModels(): LanguageModel[] {
  return CORE_TIER_ROWS.flatMap((row) => {
    const openRouterModelId =
      getOpenRouterModelIdForCoreTier(row.id)?.trim() ?? "";
    // A slot with no configured model is NOT shown. There are four slots but the
    // lineup is whatever `core-models.json` maps — running three (or two) models
    // otherwise surfaced a raw "core-4" placeholder in the picker that resolves to
    // nothing and throws at dispatch. This makes the tier COUNT config-driven, so
    // adding or dropping a Core model never needs a code change.
    if (!openRouterModelId) return [];
    const modelDisplayName = formatModelApiNameForDisplay(openRouterModelId);
    const slug = compassProviderSlug(openRouterModelId);
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
  });
}

/** Main-process only; renderer has no `process.env`. */
function trimEnv(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * DEV-ONLY Core key provider, injected from the main process (see
 * `dev_core_env.ts`, wired in `main.ts`). The default is a no-op so this module
 * stays renderer-/headless-safe and a signed release is byte-identical (the dev
 * provider is never injected in those contexts, and returns `undefined` in a
 * packaged build anyway). Lets a local `npm run package` exercise Core.
 */
interface DevCoreKeyProvider {
  apiKey(): string | undefined;
  modelId(coreTierId: string): string | undefined;
}
let devCoreKeyProvider: DevCoreKeyProvider = {
  apiKey: () => undefined,
  modelId: () => undefined,
};
export function __setDevCoreKeyProvider(provider: DevCoreKeyProvider): void {
  devCoreKeyProvider = provider;
}

/**
 * Read build-time Core env vars.
 * Must use static `process.env.*` property access so Vite `define` in
 * `vite.main.config.mts` can embed CI secrets into the packaged main bundle.
 */
function coreEnvAvailable(): boolean {
  return typeof process !== "undefined" && !!process.env;
}

/**
 * LOCAL/DEV Core key only. The embedded-key path was removed for security (the
 * master key is no longer in the Vite `define` list — it lives on the Core proxy),
 * so in a packaged release `process.env.COMPASS_OPENROUTER_API_KEY` is undefined
 * and the dev provider is a no-op → this returns undefined and Core routes through
 * the proxy. A developer running locally without the proxy can still set the var
 * in their shell to exercise Core directly. See `core_proxy.ts`.
 */
export function getCompassMasterApiKey(): string | undefined {
  const local = coreEnvAvailable()
    ? trimEnv(process.env.COMPASS_OPENROUTER_API_KEY)
    : undefined;
  return local ?? devCoreKeyProvider.apiKey();
}

export function getCoreModelIdForCoreTier(
  internalTierId: string,
): string | undefined {
  const norm = normalizeCoreTierId(internalTierId);
  // Runtime override (hosted core-models.json) wins over the build-time env, so
  // Core models can change without repackaging. Null/absent → env fallback.
  const override = getCoreModelOverrideId(norm);
  if (override) return override;
  // Build-time embedded id wins; else fall through to the dev-only local id
  // (no-op in renderer/release).
  const embedded = coreEnvAvailable()
    ? (() => {
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
      })()
    : undefined;
  return embedded ?? devCoreKeyProvider.modelId(norm);
}

/**
 * @deprecated Use `getCoreModelIdForCoreTier`. Kept because the name appears across
 * tests and call sites, and because the id it returns is no longer OpenRouter's —
 * it is the wire id the Core proxy resolves, whichever provider ends up serving it.
 */
export const getOpenRouterModelIdForCoreTier = getCoreModelIdForCoreTier;

/**
 * models.dev coordinates for a Core tier: the Atlarix provider id backing it and the
 * vendor's own model id.
 *
 * This is how Core reaches its real context window, price and capabilities. It used
 * to resolve them through the OpenRouter catalog keyed by a `vendor/model` wire id —
 * which stops matching anything once a tier routes direct, silently collapsing a 1M
 * window to a generic fallback.
 *
 * Prefers the hosted `routing` block (authoritative, and carries the vendor's exact
 * casing). Falls back to splitting the wire id, which is right for the OpenRouter-era
 * shape where the prefix IS the provider — but note that fallback is case-sensitive
 * against models.dev, so `routing` is what makes e.g. `MiniMax-M3` resolve.
 */
export function getCoreModelsDevTargetForTier(
  internalTierId: string,
): { providerId: string; modelId: string } | undefined {
  const norm = normalizeCoreTierId(internalTierId);
  const routing = getCoreTierRouting(norm);
  if (routing) {
    return { providerId: routing.provider, modelId: routing.apiModelId };
  }
  const wireId = getCoreModelIdForCoreTier(norm)?.trim();
  if (!wireId) return undefined;
  const slash = wireId.indexOf("/");
  if (slash <= 0 || slash === wireId.length - 1) return undefined;
  return {
    providerId: wireId.slice(0, slash).toLowerCase(),
    modelId: wireId.slice(slash + 1),
  };
}

/**
 * True when Core is usable in this build. Production: a proxy URL is configured
 * (no key needed in the client). Dev: a local dev key is present. Either way the
 * Core provider will resolve at dispatch.
 */
export function isCompassBuildConfigured(): boolean {
  return !!getCoreProxyBaseUrl() || !!getCompassMasterApiKey();
}

export const COMPASS_REACHABILITY_ERROR =
  "We're currently having trouble reaching Atlarix Core. Please retry or switch to another provider in Settings.";

export function compassExhaustedUserMessage(_tier?: string): string {
  return "Your Atlarix Core credit is used up. Top up your balance in Settings to continue, or add your own API keys in Settings.";
}

/**
 * Shown when Atlarix Core fails on OUR side (the proxy returns 503 core_unavailable
 * because a managed provider key is out of credit / rate-limited / down). Neutral
 * by design — the user is never told "we ran out of money"; the owner is alerted
 * separately by the proxy.
 */
export function coreUnavailableUserMessage(): string {
  return "This Atlarix Core model is temporarily unavailable. Atlarix has been informed and is working on it — we apologise for the inconvenience. In the meantime, pick another Core model above, or add your own API key in Settings.";
}
