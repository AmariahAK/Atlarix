/**
 * Atlarix Core (internal provider `compass`): env-backed OpenRouter models per Core slot.
 */

import type { ModelTier } from "@/lib/routing/capability-registry";
import {
  CORE_TIER_1,
  CORE_TIER_2,
  CORE_TIER_3,
  CORE_TIER_4,
  getOpenRouterModelIdForCoreTier,
  normalizeCoreTierId,
} from "@/ipc/shared/compass_constants";
import {
  formatModelApiNameForDisplay,
  formatModelWithProvider,
} from "@/lib/format-openrouter-model-label";

export type AtlarixCoreTierSlot = ModelTier;

export type AtlarixCoreTierPresentation = {
  /** Routing capability class (context budgeting); Core 3 and 4 both route as `thinking`. */
  slot: AtlarixCoreTierSlot;
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

const SLOT_TO_INTERNAL: { slot: AtlarixCoreTierSlot; internalTierId: string }[] = [
  { slot: "fast", internalTierId: CORE_TIER_1 },
  { slot: "balanced", internalTierId: CORE_TIER_2 },
  { slot: "thinking", internalTierId: CORE_TIER_3 },
  { slot: "thinking", internalTierId: CORE_TIER_4 },
];

function presentationForInternalTier(
  slot: AtlarixCoreTierSlot,
  internalTierId: string,
): AtlarixCoreTierPresentation {
  const openRouterModelId =
    getOpenRouterModelIdForCoreTier(internalTierId)?.trim() ?? "";
  const modelDisplayName = openRouterModelId
    ? formatModelApiNameForDisplay(openRouterModelId)
    : formatModelApiNameForDisplay(internalTierId.replace(/^(compass|core)-/, "Core "));
  const providerSlug = providerSlugFromOpenRouterId(openRouterModelId);
  return {
    slot,
    internalTierId,
    openRouterModelId,
    modelDisplayName,
    providerSlug,
    labelWithProvider: formatModelWithProvider(modelDisplayName, providerSlug),
  };
}

/** Build catalog from build-time env (`ATLARIX_CORE_MODEL_*`). Main process / IPC only. */
export function buildAtlarixCoreTierCatalog(): AtlarixCoreTierPresentation[] {
  return SLOT_TO_INTERNAL.map(({ slot, internalTierId }) =>
    presentationForInternalTier(slot, internalTierId),
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
