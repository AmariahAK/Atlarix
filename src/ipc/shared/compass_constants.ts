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
} from "@/ipc/shared/core-model-override-store";
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
/**
 * Placeholders that mean "this slot is intentionally empty".
 *
 * GitHub Actions secrets cannot hold an empty value — an empty secret is treated as
 * unset in some paths and as the literal empty string in others — so a slot with no
 * model has to carry a placeholder. Without this, `TBA` would be taken as a model id
 * and dispatched to the provider verbatim.
 *
 * Matched case-insensitively after trimming, so `TBA`, `tba`, `n/a` and `none` all work.
 */
const EMPTY_SLOT_SENTINELS = new Set(["tba", "tbd", "none", "n/a", "na", "-", "null", "undefined"]);

/**
 * Trim an env value, treating blanks AND empty-slot placeholders as absent.
 *
 * Used for the Core model slots specifically: `ATLARIX_CORE_MODEL_3=TBA` must read as
 * "no model in slot 3", exactly like an unset variable.
 */
function trimEnv(value: string | undefined): string | undefined {
  return emptySlotAware(value);
}

/**
 * Normalize a Core model slot value, or undefined when the slot is empty.
 *
 * Exported because the hosted `core-models.json` needs the same rule: a slot parked as
 * `"TBA"` in that file must read as empty too, not be dispatched as a model id.
 */
export function emptySlotAware(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (EMPTY_SLOT_SENTINELS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
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
 * The first Core slot that actually has a model mapped, or undefined if none do.
 *
 * Needed because the lineup size is config-driven: there are four slots but
 * `core-models.json` may map any subset. Anything that needs "a Core model" must ask
 * for one rather than assume `core-1` exists — dropping the tier-1 model otherwise
 * broke the BYOK-fallback path and any persisted selection pointing at it.
 */
export function getFirstConfiguredCoreTier(): string | undefined {
  return CORE_TIER_ORDER.find((tier) => !!getCoreModelIdForCoreTier(tier)?.trim());
}

/**
 * Resolve a requested Core tier to one that is actually configured.
 *
 * Returns the tier unchanged when it has a model. When it does not — a slot removed
 * from the lineup, or a selection persisted before the lineup changed — this falls
 * forward to the first configured tier instead of failing the turn. Changing the
 * lineup would otherwise break every user whose saved selection pointed at the
 * removed slot, on their very next message.
 */
export function resolveConfiguredCoreTier(
  internalTierId: string,
): { tier: string; substituted: boolean } | undefined {
  const norm = normalizeCoreTierId(internalTierId);
  if (getCoreModelIdForCoreTier(norm)?.trim()) return { tier: norm, substituted: false };
  const fallback = getFirstConfiguredCoreTier();
  return fallback ? { tier: fallback, substituted: true } : undefined;
}

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
 * Shown when the proxy refuses a Core request with 403 `account_banned`.
 *
 * Neutral, with a route back, and it does NOT carry the reason — the reason lives
 * in `public.user_bans`, which no client can read. Says what still works, because
 * it is true: BYOK and local models are outside the ban's scope, and pretending
 * otherwise would be a claim the app cannot enforce offline.
 */
export function accountBannedUserMessage(): string {
  return (
    "This account can't access Atlarix Core. If you think this is a mistake, " +
    "contact support@atlarix.dev. Your own API keys and local models still work — " +
    "add one in Settings to keep going."
  );
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

/**
 * The proxy rejected our bearer token (401/403). Core authenticates as the user with
 * their Supabase JWT, so this is an expired or invalidated session — not an outage.
 *
 * Split out of the reachability catch-all because the two need OPPOSITE actions:
 * "retry or switch provider" is advice that cannot work here, and a user following
 * it just retries into the same wall.
 */
export function compassAuthExpiredUserMessage(): string {
  return "Your Atlarix session has expired, so Core couldn't authorize this request. Sign in again from Settings and resend — your BYOK models are unaffected.";
}

/**
 * A request-level rejection the proxy passed through untouched (400/422): context
 * length exceeded, an unsupported parameter, a malformed tool schema.
 *
 * These used to render as "trouble reaching Atlarix Core", which hid the one piece
 * of information that makes them fixable. The provider's own text is included —
 * truncated, since some vendors echo a large chunk of the request back.
 */
export function compassBadRequestUserMessage(detail?: string): string {
  const trimmed = (detail ?? "").trim();
  // Prefer the vendor's `error.message` when the body is the usual JSON envelope;
  // the raw envelope is noise to a user.
  let reason = trimmed;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } };
      if (typeof parsed?.error?.message === "string") reason = parsed.error.message;
    } catch {
      /* not JSON after all — fall back to the raw text */
    }
  }
  const suffix = reason ? ` The model reported: "${reason.slice(0, 300)}"` : "";
  return `Atlarix Core rejected this request.${suffix} This is usually a problem with the request itself rather than an outage — try again, and if it repeats, switch Core model or use your own API key in Settings.`;
}
