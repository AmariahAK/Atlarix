/**
 * Atlarix Core (internal provider `compass`): env-backed OpenRouter models per routing slot.
 */

import type { ModelTier } from "@/lib/routing/capability-registry";
import {
  COMPASS_TIER_BALANCED,
  COMPASS_TIER_FAST,
  COMPASS_TIER_THINKING,
  getOpenRouterModelIdForCompassTier,
} from "@/ipc/shared/compass_constants";
import {
  formatModelApiNameForDisplay,
  formatModelWithProvider,
} from "@/lib/format-openrouter-model-label";

export type AtlarixCoreTierSlot = ModelTier;

export type AtlarixCoreTierPresentation = {
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
  { slot: "fast", internalTierId: COMPASS_TIER_FAST },
  { slot: "balanced", internalTierId: COMPASS_TIER_BALANCED },
  { slot: "thinking", internalTierId: COMPASS_TIER_THINKING },
];

function presentationForInternalTier(
  slot: AtlarixCoreTierSlot,
  internalTierId: string,
): AtlarixCoreTierPresentation {
  const openRouterModelId =
    getOpenRouterModelIdForCompassTier(internalTierId)?.trim() ?? "";
  const modelDisplayName = openRouterModelId
    ? formatModelApiNameForDisplay(openRouterModelId)
    : formatModelApiNameForDisplay(internalTierId.replace(/^compass-/, ""));
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

/** Build catalog from build-time env (`COMPASS_MODEL_*`). Main process / IPC only. */
export function buildAtlarixCoreTierCatalog(): AtlarixCoreTierPresentation[] {
  return SLOT_TO_INTERNAL.map(({ slot, internalTierId }) =>
    presentationForInternalTier(slot, internalTierId),
  );
}

export function findCatalogEntryByInternalTierId(
  catalog: AtlarixCoreTierPresentation[],
  internalTierId: string,
): AtlarixCoreTierPresentation | undefined {
  return catalog.find((e) => e.internalTierId === internalTierId);
}

/** Identity + prompts: resolve compass tier id to display line. */
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
  const modelDisplayName = formatModelApiNameForDisplay(
    internalTierId.replace(/^compass-/, ""),
  );
  const slug = providerSlugFromOpenRouterId(internalTierId.replace(/^compass-/, ""));
  return {
    modelDisplayName,
    providerSlug: slug,
    labelWithProvider: formatModelWithProvider(modelDisplayName, slug),
  };
}

/** Renderer-safe label for a compass internal tier id (catalog from IPC preferred). */
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
  if (fromList && !/^compass\s/i.test(fromList) && !/^compass-/i.test(fromList)) {
    return fromList;
  }
  return formatModelWithProvider(
    formatModelApiNameForDisplay(internalTierId.replace(/^compass-/, "")),
    "openrouter",
  );
}

export { formatModelWithProvider };
