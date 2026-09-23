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
  getCoreAuto,
  getCoreModelOverrideId,
  getCoreTierRouting,
} from "@/ipc/shared/core-model-override-store";
import { getCoreProxyBaseUrl } from "./core_proxy";
import { coreExhaustedUserMessage } from "@/shared/billing_copy";

export const COMPASS_PROVIDER_ID = "compass";

export const CORE_TIER_1 = "core-1";
export const CORE_TIER_2 = "core-2";
export const CORE_TIER_3 = "core-3";
export const CORE_TIER_4 = "core-4";

/**
 * Atlarix Auto: a FREE Core option (OpenAI complimentary tokens, a $0 floor
 * behind it), offered when the hosted config carries an `auto` block. A tier id
 * like the others so selection, dispatch, the JWT fetch and error handling are
 * all the existing Core path — but deliberately NOT in `CORE_TIER_ORDER`: it is
 * never a default, never a fallback, and never substituted for a paid slot.
 * Its prompts are shared with OpenAI, so it is only ever chosen on purpose.
 */
export const CORE_TIER_AUTO = "core-auto";

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
  const norm = normalizeCoreTierId(internalTierId);
  return (
    (CORE_TIER_ORDER as readonly string[]).includes(norm) ||
    norm === CORE_TIER_AUTO
  );
}

/** True for the free Atlarix Auto tier. */
export function isCoreAutoTier(internalTierId: string | undefined): boolean {
  return !!internalTierId && normalizeCoreTierId(internalTierId) === CORE_TIER_AUTO;
}

function compassProviderSlug(openRouterModelId: string): string {
  // Core is direct, not OpenRouter: a vendor-less id is Atlarix's own.
  if (!openRouterModelId.includes("/")) return "atlarix";
  return openRouterModelId.split("/")[0]?.toLowerCase() || "atlarix";
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
  const auto = getCoreAuto();
  // First in the Core group when offered. The answering model changes per turn
  // (the proxy walks a chain), so no single model name is claimed.
  const autoRow: LanguageModel[] = auto
    ? [
        {
          apiName: CORE_TIER_AUTO,
          displayName: auto.label,
          description: "Free · prompts are shared with OpenAI",
          type: "cloud" as const,
          dollarSigns: 0,
          maxOutputTokens: 32_000,
          // The smallest window in the chain, so compaction never overshoots
          // whichever model answers.
          contextWindow: 128_000,
        },
      ]
    : [];
  return [...autoRow, ...CORE_TIER_ROWS.flatMap((row) => {
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
  })];
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
const EMPTY_SLOT_SENTINELS = new Set([
  "tba",
  "tbd",
  "none",
  "n/a",
  "na",
  "-",
  "null",
  "undefined",
]);

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
  // Auto has no env fallback: it exists only while the hosted config offers it.
  if (norm === CORE_TIER_AUTO) return getCoreAuto()?.id;
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
  return DEFAULT_CORE_TIER_ORDER.find(
    (tier) => !!getCoreModelIdForCoreTier(tier)?.trim(),
  );
}

/**
 * Preference order when something needs "a Core model" and has no opinion.
 *
 * NOT `CORE_TIER_ORDER`. That is the display order — slot 1, 2, 3, 4 — and using it
 * here made the lowest-numbered slot the de-facto default for every unopinionated
 * caller. The default is a PRODUCT decision, and the rest follow in slot order as a
 * fallback so this still degrades correctly when the preferred slot is unconfigured.
 *
 * **core-3 first (owner, 2026-09-09).** Was core-2 for one day, from 2026-09-08. The
 * reasoning is unchanged — a new user's first turn should run on the tier we most want
 * them to judge us by — and core-3 is now the top of the lineup rather than the middle
 * of it.
 *
 * IT NAMES A SLOT, NOT A MODEL, and that is the whole point: which model sits behind a
 * slot is `core-models.json`'s business and changes without an app update. It is also
 * why moving this line moves every user who never picked a tier onto a different model
 * — worth knowing when the slot's price differs, which is why the model-changed notice
 * exists.
 */
const DEFAULT_CORE_TIER_ORDER = [
  CORE_TIER_3,
  ...CORE_TIER_ORDER.filter((t) => t !== CORE_TIER_3),
] as const;

/**
 * The tier a brand-new install's `selectedModel` points at.
 *
 * Derived from the order above rather than written a second time. These were two
 * independent literals, and the gap between them is why moving the preference
 * order to core-3 did not move a single new user: `DEFAULT_SETTINGS.selectedModel`
 * in `main/settings.ts` still said core-1, and the order's only production caller
 * is the BYOK-rescue path. Deriving it means the next change to the default lands
 * in both places or neither.
 *
 * A SLOT, not a model id — the whole reason the lineup can change without an app
 * update. If this slot is ever unconfigured, `resolveConfiguredCoreTier` falls
 * forward in slot order, so a persisted selection never becomes a dead end.
 */
export const DEFAULT_NEW_USER_CORE_TIER: string = DEFAULT_CORE_TIER_ORDER[0];

/**
 * Resolve a requested Core tier to one that is actually configured.
 *
 * Returns the tier unchanged when it has a model. When it does not — a slot removed
 * from the lineup, or a selection persisted before the lineup changed — this falls
 * forward to a configured tier instead of failing the turn. Changing the lineup would
 * otherwise break every user whose saved selection pointed at the removed slot, on
 * their very next message.
 *
 * SUBSTITUTION WALKS SLOT ORDER, NOT THE DEFAULT PREFERENCE — deliberately, and this
 * is not the same question as `getFirstConfiguredCoreTier`. That one answers "a caller
 * has no opinion, give it our best tier". This one answers "a caller's opinion no
 * longer resolves", and those want opposite things: the user DID choose, their choice
 * is gone, and silently promoting them to the top of the lineup is a bill they did not
 * ask for. Slot order is ascending by capability and price, so this lands on the
 * nearest cheaper option instead.
 *
 * It mattered little while the preference was core-2 and the lineup was flat-ish. It
 * matters now: core-3 can be several times the price of core-1, so a dropped budget
 * slot would otherwise move a cost-sensitive user straight onto the dearest model.
 */
export function resolveConfiguredCoreTier(
  internalTierId: string,
): { tier: string; substituted: boolean } | undefined {
  const norm = normalizeCoreTierId(internalTierId);
  if (getCoreModelIdForCoreTier(norm)?.trim())
    return { tier: norm, substituted: false };
  // A withdrawn Auto NEVER falls forward: every other tier is paid, and moving a
  // user who chose "free" onto a billed model is a charge they did not agree to.
  if (norm === CORE_TIER_AUTO) return undefined;
  const fallback = CORE_TIER_ORDER.find(
    (tier) => !!getCoreModelIdForCoreTier(tier)?.trim(),
  );
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
  if (norm === CORE_TIER_AUTO) return getCoreAuto()?.capability;
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

/**
 * User-facing Core failure copy MOVED to `src/shared/billing_copy.ts` on
 * 2026-08-27.
 *
 * It lived here because this is where Core lives, but this module reads env
 * vars, resolves tier ids and holds the routing table — so every renderer that
 * wanted one sentence imported all of that with it, from `src/ipc/` across the
 * layer boundary. The copy now sits beside the rest of the billing copy, which
 * is also the only way the five places that said the same thing differently
 * could be made to agree.
 *
 * Re-exported here so existing importers keep working; new code should import
 * from `@/shared/billing_copy` directly.
 */
export {
  COMPASS_REACHABILITY_ERROR,
  accountBannedUserMessage,
  compassAuthExpiredUserMessage,
  compassBadRequestUserMessage,
  coreUnavailableUserMessage,
} from "@/shared/billing_copy";

/**
 * @deprecated Use `coreExhaustedUserMessage` from `@/shared/billing_copy`.
 * The `tier` argument was never read — an artefact of when running out of credit
 * was believed to be a tier-specific event. It is not: a 402 means the spendable
 * total is zero, which looks identical on every plan.
 */
export function compassExhaustedUserMessage(_tier?: string): string {
  return coreExhaustedUserMessage();
}
