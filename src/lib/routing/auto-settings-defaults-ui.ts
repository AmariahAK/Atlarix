/**
 * Auto routing defaults safe for renderer (no DB / main-only imports).
 */

import type { UserSettings } from "@/lib/schemas";
import {
  COMPASS_TIER_BALANCED,
  COMPASS_TIER_FAST,
  COMPASS_TIER_THINKING,
} from "@/ipc/shared/compass_constants";
import { isCompassTierId } from "@/shared/compass_product_copy";

export type AutoSettingsPatch = {
  autoProviderId: string | null;
  autoModelIds?: [string, string, string];
};

function tripleFromFavorites(ids: string[]): [string, string, string] | undefined {
  if (ids.length < 1) return undefined;
  const a = ids[0];
  const b = ids[1] ?? a;
  const c = ids[2] ?? b;
  return [a, b, c];
}

function hasFilledTriple(ids: unknown): ids is [string, string, string] {
  return (
    Array.isArray(ids) &&
    ids.length >= 3 &&
    ids.every((s) => typeof s === "string" && s.trim().length > 0)
  );
}

/** True when autoModelIds match the selected auto provider (e.g. not OpenRouter ids on compass). */
export function autoModelIdsMatchProvider(
  providerId: string,
  autoModelIds: unknown,
): boolean {
  if (!hasFilledTriple(autoModelIds)) return false;
  if (providerId === "compass") {
    return autoModelIds.every((id) => isCompassTierId(id.trim()));
  }
  // OpenRouter / cloud: must not still be compass synthetic tier ids
  if (autoModelIds.some((id) => isCompassTierId(id.trim()))) return false;
  return true;
}

export function buildAutoSettingsForProvider(
  providerId: string | null,
  settings: UserSettings,
): AutoSettingsPatch {
  if (!providerId) {
    return { autoProviderId: null, autoModelIds: undefined };
  }
  if (providerId === "compass") {
    return {
      autoProviderId: providerId,
      autoModelIds: [COMPASS_TIER_FAST, COMPASS_TIER_BALANCED, COMPASS_TIER_THINKING],
    };
  }
  const ollamaFavs =
    (settings.providerSettings?.ollama as { favoriteModelIds?: string[] } | undefined)
      ?.favoriteModelIds ?? [];
  const lmStudioFavs =
    (settings.providerSettings?.lmstudio as { favoriteModelIds?: string[] } | undefined)
      ?.favoriteModelIds ?? [];
  if (providerId === "ollama") {
    const t = tripleFromFavorites(ollamaFavs);
    if (t) return { autoProviderId: providerId, autoModelIds: t };
  }
  if (providerId === "lmstudio") {
    const t = tripleFromFavorites(lmStudioFavs);
    if (t) return { autoProviderId: providerId, autoModelIds: t };
  }
  const existing = settings.autoModelIds;
  if (
    settings.autoProviderId === providerId &&
    autoModelIdsMatchProvider(providerId, existing)
  ) {
    return {
      autoProviderId: providerId,
      autoModelIds: existing as [string, string, string],
    };
  }
  return { autoProviderId: providerId, autoModelIds: undefined };
}

const AUTO_PROVIDER_PRIORITY = [
  "compass",
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "groq",
  "togetherai",
  "mistral",
  "xai",
] as const;

function settingsProviderHasKey(settings: UserSettings, providerId: string): boolean {
  return Boolean(settings.providerSettings?.[providerId]?.apiKey?.value?.trim());
}

export function pickDefaultAutoProviderIdSync(
  settings: UserSettings,
  options: { compassAvailable: boolean; configuredProviderIds: string[] },
): string | null {
  const { compassAvailable, configuredProviderIds } = options;
  const hasKey = (id: string) =>
    id === "compass"
      ? compassAvailable
      : configuredProviderIds.includes(id) || settingsProviderHasKey(settings, id);

  if (settings.autoProviderId && hasKey(settings.autoProviderId)) {
    return settings.autoProviderId;
  }
  for (const id of AUTO_PROVIDER_PRIORITY) {
    if (hasKey(id)) return id;
  }
  const ollamaFavs =
    (settings.providerSettings?.ollama as { favoriteModelIds?: string[] } | undefined)
      ?.favoriteModelIds ?? [];
  if (ollamaFavs.length >= 1 && hasKey("ollama")) return "ollama";
  const lmStudioFavs =
    (settings.providerSettings?.lmstudio as { favoriteModelIds?: string[] } | undefined)
      ?.favoriteModelIds ?? [];
  if (lmStudioFavs.length >= 1 && hasKey("lmstudio")) return "lmstudio";
  return null;
}

export function getDefaultAutoSettingsPatchSync(
  settings: UserSettings,
  options: { compassAvailable: boolean; configuredProviderIds: string[] },
): Partial<UserSettings> | null {
  const providerId = pickDefaultAutoProviderIdSync(settings, options);
  if (!providerId) return null;
  const patch = buildAutoSettingsForProvider(providerId, settings);
  if (!patch.autoModelIds?.some((s) => s?.trim())) {
    if (providerId !== "openrouter") return null;
  }
  return {
    autoProviderId: patch.autoProviderId,
    autoModelIds: patch.autoModelIds,
  };
}

/** Re-apply Speed/Standard/Deep (or favorites) when provider changes or tier ids are stale. */
export function reselectAutoTierModels(
  providerId: string | null,
  settings: UserSettings,
): AutoSettingsPatch {
  return buildAutoSettingsForProvider(providerId, settings);
}
