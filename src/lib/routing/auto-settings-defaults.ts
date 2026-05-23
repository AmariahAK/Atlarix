/**
 * Auto routing defaults (main process): resolves provider keys from DB / env.
 */

import type { UserSettings } from "@/lib/schemas";
import { getCompassMasterApiKey } from "@/ipc/shared/compass_constants";
import { getConfiguredProviders } from "@/ipc/shared/provider_api_keys";
import { getLanguageModelProviders } from "@/ipc/shared/language_model_helpers";
import { hasAutoRoutingModelConfig } from "@/ipc/utils/get_model_client";
import {
  autoModelIdsMatchProvider,
  buildAutoSettingsForProvider,
  pickDefaultAutoProviderIdSync,
  type AutoSettingsPatch,
} from "./auto-settings-defaults-ui";

export type { AutoSettingsPatch };
export { buildAutoSettingsForProvider, getDefaultAutoSettingsPatchSync } from "./auto-settings-defaults-ui";

function settingsProviderHasKey(settings: UserSettings, providerId: string): boolean {
  return Boolean(settings.providerSettings?.[providerId]?.apiKey?.value?.trim());
}

async function providerIdHasCredentials(
  providerId: string,
  settings: UserSettings,
  configuredIds: string[],
): Promise<boolean> {
  if (providerId === "compass") return !!getCompassMasterApiKey();
  if (configuredIds.includes(providerId)) return true;
  return settingsProviderHasKey(settings, providerId);
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

export async function pickDefaultAutoProviderId(
  settings: UserSettings,
): Promise<string | null> {
  const configured = await getConfiguredProviders();
  if (
    settings.autoProviderId &&
    (await providerIdHasCredentials(settings.autoProviderId, settings, configured))
  ) {
    return settings.autoProviderId;
  }
  for (const id of AUTO_PROVIDER_PRIORITY) {
    if (await providerIdHasCredentials(id, settings, configured)) {
      return id;
    }
  }
  return pickDefaultAutoProviderIdSync(settings, {
    compassAvailable: !!getCompassMasterApiKey(),
    configuredProviderIds: configured,
  });
}

export async function resolveDefaultAutoRoutingSettings(
  settings: UserSettings,
): Promise<Partial<UserSettings> | null> {
  const providerId = await pickDefaultAutoProviderId(settings);
  if (!providerId) return null;
  const patch = buildAutoSettingsForProvider(providerId, settings);
  if (!patch.autoProviderId) return null;
  const ids = patch.autoModelIds;
  if (!ids?.some((s) => typeof s === "string" && s.trim())) {
    if (providerId !== "openrouter") return null;
  }
  return {
    autoProviderId: patch.autoProviderId,
    autoModelIds: patch.autoModelIds,
  };
}

export async function ensureAutoRoutingConfigAsync(
  settings: UserSettings,
): Promise<UserSettings> {
  if (!settings.autoModelRouting) return settings;

  const pid = settings.autoProviderId;
  if (pid && !autoModelIdsMatchProvider(pid, settings.autoModelIds)) {
    const patch = buildAutoSettingsForProvider(pid, settings);
    if (patch.autoModelIds?.some((s) => s?.trim())) {
      return { ...settings, ...patch };
    }
  }

  if (hasAutoRoutingModelConfig(settings)) {
    return settings;
  }
  const patch = await resolveDefaultAutoRoutingSettings(settings);
  if (!patch) return settings;
  return { ...settings, ...patch };
}
