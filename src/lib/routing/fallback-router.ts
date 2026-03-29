/**
 * Resolve tier to user's configured model with fallback chain.
 * thinking → balanced → fast → last configured. Never throw; always return a model.
 */

import type { UserSettings } from "../schemas";
import type { LargeLanguageModel } from "../schemas";
import type { ModelTier } from "./capability-registry";

/**
 * Get the user's configured model for a given tier from Auto settings.
 * autoModelIds: [Fast, Balanced, Thinking] (indices 0, 1, 2).
 * Falls back to next tier if that slot is missing.
 */
export function resolveTierToModel(
  settings: UserSettings,
  tier: ModelTier
): LargeLanguageModel {
  const providerId = settings.autoProviderId ?? null;
  const autoModelIds = settings.autoModelIds;
  const tierIndex = tier === "fast" ? 0 : tier === "balanced" ? 1 : 2;

  if (providerId && Array.isArray(autoModelIds) && autoModelIds.length >= 1) {
    // Try requested tier, then fallback in order: thinking→balanced→fast→last
    const order: number[] =
      tierIndex === 2
        ? [2, 1, 0]
        : tierIndex === 1
          ? [1, 2, 0]
          : [0, 1, 2];
    for (const i of order) {
      const name = autoModelIds[i];
      if (name) {
        return { provider: providerId, name };
      }
    }
    return {
      provider: providerId,
      name: autoModelIds[0],
    };
  }

  // No Auto config: use selected model
  const selected = settings.selectedModel;
  if (selected?.provider && selected?.name) {
    return selected;
  }

  // Ultimate fallback (should not happen if settings are valid)
  return {
    provider: "compass",
    name: "compass-fast",
  };
}
