/**
 * Atlarix Core (internal provider `compass`): env-backed OpenRouter models per Core slot.
 */

import {
  CORE_TIER_ORDER,
  getOpenRouterModelIdForCoreTier,
  normalizeCoreTierId,
} from "@/ipc/shared/compass_constants";
import {
  formatModelApiNameForDisplay,
  formatModelWithProvider,
} from "@/lib/format-openrouter-model-label";

export type AtlarixCoreTierPresentation = {
  /** Canonical Core model id (`core-1`..`core-4`). */
  internalTierId: string;
  openRouterModelId: string;
  modelDisplayName: string;
  providerSlug: string;
  /** Full user-facing line: `deepseek v4 pro (openrouter)` */
  labelWithProvider: string;
};

function providerSlugFromOpenRouterId(openRouterModelId: string): string {
  const trimmed = openRouterModelId.trim();
  if (!trimmed.includes("/")) return "openrouter";
  return trimmed.split("/")[0]?.toLowerCase() || "openrouter";
}

function presentationForInternalTier(
  internalTierId: string,
): AtlarixCoreTierPresentation {
  const openRouterModelId =
    getOpenRouterModelIdForCoreTier(internalTierId)?.trim() ?? "";
  const modelDisplayName = openRouterModelId
    ? formatModelApiNameForDisplay(openRouterModelId)
    : formatModelApiNameForDisplay(internalTierId.replace(/^(compass|core)-/, "Core "));
  const providerSlug = providerSlugFromOpenRouterId(openRouterModelId);
  return {
    internalTierId,
    openRouterModelId,
    modelDisplayName,
    providerSlug,
    labelWithProvider: formatModelWithProvider(modelDisplayName, providerSlug),
  };
}

/** Build catalog of the four Core models. Resolves current ids (override or env). */
export function buildAtlarixCoreTierCatalog(): AtlarixCoreTierPresentation[] {
  return CORE_TIER_ORDER.map((internalTierId) =>
    presentationForInternalTier(internalTierId),
  );
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
): { modelDisplayName: string; providerSlug: string; labelWithProvider: string } {
  const resolvedCatalog =
    catalog ??
    (typeof process !== "undefined" ? buildAtlarixCoreTierCatalog() : undefined);
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
  const fallbackName = normalizeCoreTierId(internalTierId).replace(/^core-/, "Core ");
  const modelDisplayName = formatModelApiNameForDisplay(fallbackName);
  const slug = "openrouter";
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
  if (fromList && !/^(compass|core)\s/i.test(fromList) && !/^(compass|core)-/i.test(fromList)) {
    return fromList;
  }
  return formatModelWithProvider(
    formatModelApiNameForDisplay(
      normalizeCoreTierId(internalTierId).replace(/^core-/, "Core "),
    ),
    "openrouter",
  );
}

export { formatModelWithProvider };
