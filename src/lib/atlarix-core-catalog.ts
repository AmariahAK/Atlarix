/**
 * Atlarix Core (internal provider `compass`): the configured model per Core slot.
 * The id is `vendor/model`; the vendor segment drives the display slug.
 */

import {
  CORE_TIER_AUTO,
  CORE_TIER_ORDER,
  getCoreModelIdForCoreTier,
  isCoreAutoTier,
  normalizeCoreTierId,
} from "@/ipc/shared/compass_constants";
import { getCoreAuto } from "@/ipc/shared/core-model-override-store";

/**
 * The slug shown when a Core model names no vendor. ATLARIX, not "openrouter":
 * Core has been 100% direct since the OpenRouter migration, and this fallback
 * reached both the chip ("Core 3 (openrouter)" while loading) and the model's own
 * identity line ("I'm Core Auto (openrouter)").
 */
const CORE_FALLBACK_SLUG = "atlarix";
import {
  formatModelApiNameForDisplay,
  formatModelWithProvider,
} from "@/lib/format-openrouter-model-label";

export type AtlarixCoreTierPresentation = {
  /** Canonical Core model id (`core-1`..`core-4`). */
  internalTierId: string;
  /** The configured wire id for this tier (`vendor/model`). */
  coreModelId: string;
  modelDisplayName: string;
  providerSlug: string;
  /** Full user-facing line: `deepseek v4 pro (deepseek)` */
  labelWithProvider: string;
};

/** Display slug from the wire id's vendor segment. */
function providerSlugFromCoreModelId(coreModelId: string): string {
  const trimmed = coreModelId.trim();
  if (!trimmed.includes("/")) return CORE_FALLBACK_SLUG;
  return trimmed.split("/")[0]?.toLowerCase() || CORE_FALLBACK_SLUG;
}

function presentationForInternalTier(
  internalTierId: string,
): AtlarixCoreTierPresentation {
  const coreModelId = getCoreModelIdForCoreTier(internalTierId)?.trim() ?? "";
  if (isCoreAutoTier(internalTierId) && coreModelId) {
    const label = getCoreAuto()?.label ?? "Atlarix Auto";
    return {
      internalTierId: CORE_TIER_AUTO,
      coreModelId,
      modelDisplayName: label,
      providerSlug: CORE_FALLBACK_SLUG,
      labelWithProvider: label,
    };
  }
  const modelDisplayName = coreModelId
    ? formatModelApiNameForDisplay(coreModelId)
    : formatModelApiNameForDisplay(
        internalTierId.replace(/^(compass|core)-/, "Core "),
      );
  const providerSlug = providerSlugFromCoreModelId(coreModelId);
  return {
    internalTierId,
    coreModelId,
    modelDisplayName,
    providerSlug,
    labelWithProvider: formatModelWithProvider(modelDisplayName, providerSlug),
  };
}

/**
 * Catalog of the CONFIGURED Core models, in slot order.
 *
 * Slots with no mapped model are omitted — the lineup is whatever
 * `core-models.json` maps, not a fixed four. Keeping an unconfigured slot produced a
 * "Core 4" entry that resolved to nothing and threw at dispatch.
 */
export function buildAtlarixCoreTierCatalog(): AtlarixCoreTierPresentation[] {
  // Auto first, as in the picker; filtered out below when not offered.
  return [CORE_TIER_AUTO, ...CORE_TIER_ORDER].map((internalTierId) =>
    presentationForInternalTier(internalTierId),
  ).filter((entry) => entry.coreModelId !== "");
}

export function findCatalogEntryByInternalTierId(
  catalog: AtlarixCoreTierPresentation[],
  internalTierId: string,
): AtlarixCoreTierPresentation | undefined {
  const normalized = normalizeCoreTierId(internalTierId);
  return catalog.find((e) => e.internalTierId === normalized);
}

/** Identity + prompts: resolve Core tier id to display line. */
export function resolveAtlarixCoreIdentity(
  internalTierId: string,
  catalog?: AtlarixCoreTierPresentation[],
): {
  modelDisplayName: string;
  providerSlug: string;
  labelWithProvider: string;
} {
  const resolvedCatalog =
    catalog ??
    (typeof process !== "undefined"
      ? buildAtlarixCoreTierCatalog()
      : undefined);
  const entry = resolvedCatalog
    ? findCatalogEntryByInternalTierId(resolvedCatalog, internalTierId)
    : undefined;
  if (entry) {
    return {
      modelDisplayName: entry.modelDisplayName,
      providerSlug: entry.providerSlug,
      labelWithProvider: entry.labelWithProvider,
    };
  }
  const fallbackName = normalizeCoreTierId(internalTierId).replace(
    /^core-/,
    "Core ",
  );
  const modelDisplayName = isCoreAutoTier(internalTierId)
    ? "Atlarix Auto"
    : formatModelApiNameForDisplay(fallbackName);
  const slug = CORE_FALLBACK_SLUG;
  return {
    modelDisplayName,
    providerSlug: slug,
    labelWithProvider: formatModelWithProvider(modelDisplayName, slug),
  };
}

/** Renderer-safe label for a Core internal tier id (catalog from IPC preferred). */
export function displayLabelForCompassTier(
  internalTierId: string,
  catalog?: AtlarixCoreTierPresentation[],
  languageModelDisplayName?: string,
): string {
  const entry = catalog
    ? findCatalogEntryByInternalTierId(catalog, internalTierId)
    : undefined;
  if (entry) return entry.labelWithProvider;
  const fromList = languageModelDisplayName?.trim();
  if (
    fromList &&
    !/^(compass|core)\s/i.test(fromList) &&
    !/^(compass|core)-/i.test(fromList)
  ) {
    return fromList;
  }
  if (isCoreAutoTier(internalTierId)) return "Atlarix Auto";
  return formatModelWithProvider(
    formatModelApiNameForDisplay(
      normalizeCoreTierId(internalTierId).replace(/^core-/, "Core "),
    ),
    CORE_FALLBACK_SLUG,
  );
}

/**
 * Renderer-safe: build a Core tier presentation from a synthetic Core model
 * (`apiName` = `core-N`, `displayName` = `Model Name (slug)`) as returned by
 * `getCompassSyntheticModels` over the `get-language-models-by-providers` IPC.
 *
 * The renderer sources Core names from that IPC (the same one the model picker
 * uses) rather than the `compass:get-tier-catalog` handler: in the packaged main
 * bundle the tier-catalog builder resolves the Core ids through a different
 * `compass_constants` module instance than the one the runtime override store is
 * written to, so it returns the raw `core-N` placeholders. The language-models
 * path resolves them correctly, so we reuse it here.
 */
export function coreTierPresentationFromModel(model: {
  apiName: string;
  displayName: string;
}): AtlarixCoreTierPresentation {
  const match = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(model.displayName);
  const modelDisplayName = (match?.[1] ?? model.displayName).trim();
  // Atlarix Auto names no single model (the proxy picks per turn), so its slug
  // is Atlarix's own — never "openrouter", which would put a false provider in
  // the model's identity line.
  const providerSlug = (
    match?.[2] ?? CORE_FALLBACK_SLUG
  )
    .trim()
    .toLowerCase();
  return {
    internalTierId: model.apiName,
    coreModelId: "",
    modelDisplayName,
    providerSlug,
    labelWithProvider: model.displayName,
  };
}

export { formatModelWithProvider };
