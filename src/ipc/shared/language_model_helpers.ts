import { db } from "@/db";
import {
  language_model_providers as languageModelProvidersSchema,
  language_models as languageModelsSchema,
} from "@/db/schema";
import type { LanguageModelProvider, LanguageModel } from "@/ipc/ipc_types";
import { eq } from "drizzle-orm";
import {
  LOCAL_PROVIDERS,
  CLOUD_PROVIDERS,
  PROVIDER_TO_ENV_VAR,
} from "./language_model_constants";
import { getModelsFromModelsDev } from "@/lib/models_dev";
import {
  fetchModelsFromProvider,
  supportsProviderNativeFetch,
} from "@/lib/provider_model_fetchers";
import { getProviderApiKey } from "./provider_api_keys";
import { getEnvVar } from "../utils/read_env";
import { COMPASS_PROVIDER_ID, COMPASS_SYNTHETIC_MODELS } from "./compass_constants";

/**
 * Fetches language model providers from both the database (custom) and hardcoded constants (cloud),
 * merging them with custom providers taking precedence.
 * @returns A promise that resolves to an array of LanguageModelProvider objects.
 */
export async function getLanguageModelProviders(): Promise<
  LanguageModelProvider[]
> {
  // Fetch custom providers from the database
  const customProvidersDb = await db
    .select()
    .from(languageModelProvidersSchema);

  const customProvidersMap = new Map<string, LanguageModelProvider>();
  for (const cp of customProvidersDb) {
    customProvidersMap.set(cp.id, {
      id: cp.id,
      name: cp.name,
      apiBaseUrl: cp.api_base_url,
      envVarName: cp.env_var_name ?? undefined,
      type: "custom",
      // hasFreeTier, websiteUrl, gatewayPrefix are not in the custom DB schema
      // They will be undefined unless overridden by hardcoded values if IDs match
    });
  }

  // Get hardcoded cloud providers
  const hardcodedProviders: LanguageModelProvider[] = [];
  for (const providerKey in CLOUD_PROVIDERS) {
    if (Object.prototype.hasOwnProperty.call(CLOUD_PROVIDERS, providerKey)) {
      // Ensure providerKey is a key of PROVIDERS
      const key = providerKey as keyof typeof CLOUD_PROVIDERS;
      const providerDetails = CLOUD_PROVIDERS[key];
      if (providerDetails) {
        // Ensure providerDetails is not undefined
        hardcodedProviders.push({
          id: key,
          name: providerDetails.displayName,
          hasFreeTier: providerDetails.hasFreeTier,
          websiteUrl: providerDetails.websiteUrl,
          gatewayPrefix: providerDetails.gatewayPrefix,
          secondary: providerDetails.secondary,
          envVarName: PROVIDER_TO_ENV_VAR[key] ?? undefined,
          type: "cloud",
          // apiBaseUrl is not directly in PROVIDERS
        });
      }
    }
  }

  for (const providerKey in LOCAL_PROVIDERS) {
    if (Object.prototype.hasOwnProperty.call(LOCAL_PROVIDERS, providerKey)) {
      const key = providerKey as keyof typeof LOCAL_PROVIDERS;
      const providerDetails = LOCAL_PROVIDERS[key];
      hardcodedProviders.push({
        id: key,
        name: providerDetails.displayName,
        hasFreeTier: providerDetails.hasFreeTier,
        type: "local",
      });
    }
  }

  hardcodedProviders.sort((a, b) => {
    if (a.id === COMPASS_PROVIDER_ID) return -1;
    if (b.id === COMPASS_PROVIDER_ID) return 1;
    return 0;
  });

  return [...hardcodedProviders, ...customProvidersMap.values()];
}

/**
 * Fetches language models for a specific provider.
 * @param obj An object containing the providerId.
 * @returns A promise that resolves to an array of LanguageModel objects.
 */
export async function getLanguageModels({
  providerId,
}: {
  providerId: string;
}): Promise<LanguageModel[]> {
  const allProviders = await getLanguageModelProviders();
  const provider = allProviders.find((p) => p.id === providerId);

  if (!provider) {
    console.warn(`Provider with ID "${providerId}" not found.`);
    return [];
  }

  if (providerId === COMPASS_PROVIDER_ID) {
    return [...COMPASS_SYNTHETIC_MODELS];
  }

  // Get custom models from DB for all provider types
  let customModels: LanguageModel[] = [];

  try {
    const customModelsDb = await db
      .select({
        id: languageModelsSchema.id,
        displayName: languageModelsSchema.displayName,
        apiName: languageModelsSchema.apiName,
        description: languageModelsSchema.description,
        maxOutputTokens: languageModelsSchema.max_output_tokens,
        contextWindow: languageModelsSchema.context_window,
      })
      .from(languageModelsSchema)
      .where(
        isCustomProvider({ providerId })
          ? eq(languageModelsSchema.customProviderId, providerId)
          : eq(languageModelsSchema.builtinProviderId, providerId),
      );

    customModels = customModelsDb.map((model) => ({
      ...model,
      description: model.description ?? "",
      tag: undefined,
      maxOutputTokens: model.maxOutputTokens ?? undefined,
      contextWindow: model.contextWindow ?? undefined,
      type: "custom",
    }));
  } catch (error) {
    console.error(
      `Error fetching custom models for provider "${providerId}" from DB:`,
      error,
    );
    // Continue with empty custom models array
  }

  // If it's a cloud provider: try provider API first (when key exists), else models.dev
  let cloudModels: LanguageModel[] = [];
  if (provider.type === "cloud") {
    let apiKey: string | undefined;
    try {
      apiKey =
        (await getProviderApiKey(providerId)) ??
        (provider.envVarName ? getEnvVar(provider.envVarName) : undefined);
    } catch {
      // DB not available (e.g. renderer process)
    }

    if (!apiKey) {
      // No API key: return 0 models (like OpenRouter). Do not show hardcoded models.
      cloudModels = [];
    } else if (supportsProviderNativeFetch(providerId)) {
      try {
        cloudModels = await fetchModelsFromProvider(providerId, apiKey);
      } catch (error) {
        console.warn(
          `[${providerId}] Native fetch failed, falling back to models.dev:`,
          error,
        );
        // Fallback to models.dev only when we have a key but native fetch failed
        try {
          cloudModels = await getModelsFromModelsDev(providerId);
        } catch (devError) {
          console.warn(
            `[models.dev] Failed to fetch models for "${providerId}":`,
            devError,
          );
        }
      }
    } else {
      // Has key but no native fetch - use models.dev
      try {
        cloudModels = await getModelsFromModelsDev(providerId);
      } catch (error) {
        console.warn(
          `[models.dev] Failed to fetch models for "${providerId}":`,
          error,
        );
      }
    }
  }

  return [...cloudModels, ...customModels];
}

/**
 * Fetches all language models grouped by their provider IDs.
 * @returns A promise that resolves to a Record mapping provider IDs to arrays of LanguageModel objects.
 */
export async function getLanguageModelsByProviders(): Promise<
  Record<string, LanguageModel[]>
> {
  const providers = await getLanguageModelProviders();

  const modelsByProvider: Record<string, LanguageModel[]> = {};

  for (const provider of providers) {
    // Local providers (Ollama, LM Studio): merge live CLI/API list with any DB custom rows
    if (provider.type === "local") {
      if (provider.id === "ollama" || provider.id === "lmstudio") {
        try {
          const fromDb = await getLanguageModels({ providerId: provider.id });
          let live: LanguageModel[] = [];
          if (provider.id === "ollama") {
            const { fetchOllamaModels } = await import(
              "../handlers/local_model_ollama_handler"
            );
            const r = await fetchOllamaModels();
            live = r.models.map((m) => ({
              apiName: m.modelName,
              displayName: m.displayName,
              description: "",
              type: "local" as const,
              dollarSigns: 0,
            }));
          } else {
            const { fetchLMStudioModels } = await import(
              "../handlers/local_model_lmstudio_handler"
            );
            const r = await fetchLMStudioModels();
            live = r.models.map((m) => ({
              apiName: m.modelName,
              displayName: m.displayName,
              description: "",
              type: "local" as const,
              dollarSigns: 0,
            }));
          }
          const seen = new Set(live.map((x) => x.apiName));
          const merged: LanguageModel[] = [...live];
          for (const m of fromDb) {
            if (!seen.has(m.apiName)) {
              merged.push(m);
              seen.add(m.apiName);
            }
          }
          modelsByProvider[provider.id] = merged;
        } catch {
          try {
            modelsByProvider[provider.id] = await getLanguageModels({
              providerId: provider.id,
            });
          } catch {
            modelsByProvider[provider.id] = [];
          }
        }
      } else {
        try {
          modelsByProvider[provider.id] = await getLanguageModels({
            providerId: provider.id,
          });
        } catch {
          modelsByProvider[provider.id] = [];
        }
      }
      continue;
    }

    // Handle other providers
    const models = await getLanguageModels({ providerId: provider.id });
    modelsByProvider[provider.id] = models;
  }

  return modelsByProvider;
}

export function isCustomProvider({ providerId }: { providerId: string }) {
  return providerId.startsWith(CUSTOM_PROVIDER_PREFIX);
}

export const CUSTOM_PROVIDER_PREFIX = "custom::";
