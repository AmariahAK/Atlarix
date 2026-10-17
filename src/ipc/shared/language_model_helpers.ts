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
  resolveProviderBaseUrl,
  resolveProviderEnvVarNames,
  resolveProviderNpm,
} from "./language_model_constants";
import {
  getModelsFromModelsDev,
  getModelsDevProviderCatalog,
} from "@/lib/models_dev";
import { fetchModelsFromProvider } from "@/lib/provider_model_fetchers";
import { mergeByApiName } from "@/lib/models/merge-provider-models";
import { getProviderApiKey } from "./provider_api_keys";
import { getEnvVar } from "../utils/read_env";
import {
  COMPASS_PROVIDER_ID,
  getCompassSyntheticModels,
} from "./compass_constants";
import {
  isReasoningCapableModel,
  effortChoicesForModel,
  resolveCapabilityProviderId,
  resolveReasoningCatalogModelId,
} from "@/lib/routing/reasoning-detector";
import { detectAudioCapability } from "@/lib/routing/model-capability-profile";
import { rememberCustomProviderFormats } from "@/lib/routing/custom-provider-format";

/** The models.dev `npm` value of the Anthropic Messages API (provider-sdk-factories). */
const ANTHROPIC_NPM = "@ai-sdk/anthropic";

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
      // The Anthropic format dispatches through the catalog's own Anthropic SDK
      // factory (provider-sdk-factories), like any models.dev provider on it.
      ...(cp.api_format === "anthropic"
        ? { apiFormat: "anthropic" as const, npm: ANTHROPIC_NPM }
        : {}),
      ...(cp.auth_header === "x-api-key" || cp.auth_header === "bearer"
        ? { authHeader: cp.auth_header }
        : {}),
      type: "custom",
      // hasFreeTier, websiteUrl, gatewayPrefix are not in the custom DB schema
      // They will be undefined unless overridden by hardcoded values if IDs match
    });
  }
  // Capability lookups (thinking, /effort, cache markers) read this.
  rememberCustomProviderFormats([...customProvidersMap.values()]);

  // The overlaid (first-class) cloud providers. The catalog supplies the endpoint,
  // the wire format and the env-var list; this table supplies the curated name, the
  // key-console link, Atlarix routing fields, and any deliberate pin. Fetched once
  // and indexed so the merge below is a lookup rather than a scan per provider.
  const catalogById = new Map<
    string,
    Awaited<ReturnType<typeof getModelsDevProviderCatalog>>[number]
  >();
  try {
    for (const c of await getModelsDevProviderCatalog())
      catalogById.set(c.id, c);
  } catch {
    /* models.dev unavailable — the overlay's own pins still resolve below. */
  }

  const hardcodedProviders: LanguageModelProvider[] = [];
  for (const providerKey in CLOUD_PROVIDERS) {
    if (Object.prototype.hasOwnProperty.call(CLOUD_PROVIDERS, providerKey)) {
      // Ensure providerKey is a key of PROVIDERS
      const key = providerKey as keyof typeof CLOUD_PROVIDERS;
      const providerDetails = CLOUD_PROVIDERS[key];
      if (providerDetails) {
        const catalog = catalogById.get(key);
        const envVarNames = resolveProviderEnvVarNames(
          key,
          catalog?.envVarNames,
        );
        hardcodedProviders.push({
          id: key,
          name: providerDetails.displayName,
          hasFreeTier: providerDetails.hasFreeTier,
          websiteUrl: providerDetails.websiteUrl,
          gatewayPrefix: providerDetails.gatewayPrefix,
          secondary: providerDetails.secondary,
          // `envVarName` stays the PRIMARY name for existing consumers; the full
          // ordered list rides alongside so key lookup can try each in turn.
          envVarName: envVarNames[0],
          envVarNames,
          apiBaseUrl: resolveProviderBaseUrl(key, catalog?.apiBaseUrl),
          npm: resolveProviderNpm(key, catalog?.npm),
          type: "cloud",
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
    const pin = (id: string) =>
      id === COMPASS_PROVIDER_ID ? 0 : id === "openrouter" ? 1 : 2;
    const da = pin(a.id);
    const db = pin(b.id);
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });

  // Third source: the full models.dev provider catalog (opencode parity). Every
  // provider models.dev knows becomes connectable via the shared OpenAI-compatible
  // path (base URL + key env var from api.json); models + limits stay live. The
  // hardcoded (special-auth / native) and custom entries win by id, so this only
  // ADDS the long tail. Never throws — models.dev has a last-good cache fallback.
  const existingIds = new Set<string>([
    ...hardcodedProviders.map((p) => p.id),
    ...customProvidersMap.keys(),
  ]);
  const modelsDevProviders: LanguageModelProvider[] = [];
  for (const c of catalogById.values()) {
    if (existingIds.has(c.id)) continue;
    existingIds.add(c.id);
    const envVarNames = resolveProviderEnvVarNames(c.id, c.envVarNames);
    modelsDevProviders.push({
      id: c.id,
      name: c.name,
      apiBaseUrl: resolveProviderBaseUrl(c.id, c.apiBaseUrl),
      envVarName: envVarNames[0],
      envVarNames,
      npm: c.npm,
      type: "cloud",
    });
  }
  modelsDevProviders.sort((a, b) => a.name.localeCompare(b.name));

  const all = [
    ...hardcodedProviders,
    ...customProvidersMap.values(),
    ...modelsDevProviders,
  ];
  for (const p of all) providerNames.set(p.id, p.name);
  return all;
}

/** Display names from the last provider listing (read before any turn runs). */
const providerNames = new Map<string, string>();

/**
 * A provider as people know it: "QA ai49 Bad Key", not "custom::qa-ai49-badkey"
 * (app QA). Synchronous, for error paths; falls back to the id without its
 * custom:: prefix when the list hasn't been read in this process.
 */
export function providerDisplayName(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  return providerNames.get(providerId) ?? providerId.replace(/^custom::/, "");
}

/**
 * Fetches language models for a specific provider.
 * @param obj An object containing the providerId.
 * @returns A promise that resolves to an array of LanguageModel objects.
 */
/**
 * A provider the user added: its endpoint's live model list, cached per
 * provider, address and key for a minute (failures too), and shared while a
 * fetch is in flight. getLanguageModels runs several times per turn
 * (findLanguageModel → context limit, token counts), and a dead endpoint
 * would otherwise cost each call its full wait.
 */
const LIVE_TTL_MS = 60_000;
const liveCache = new Map<
  string,
  { at: number; models: Promise<LanguageModel[]> }
>();

export async function liveCustomModels(
  providerId: string,
  baseUrl: string,
  apiKey: string | undefined,
  now = Date.now(),
  wire: Pick<LanguageModelProvider, "apiFormat" | "authHeader"> = {},
): Promise<LanguageModel[]> {
  const { createHash } = await import("node:crypto");
  const keyTag = apiKey?.trim()
    ? createHash("sha256").update(apiKey.trim()).digest("hex").slice(0, 12)
    : "none";
  const cacheKey = `${providerId}|${baseUrl}|${keyTag}|${wire.apiFormat ?? "openai"}|${wire.authHeader ?? ""}`;
  const hit = liveCache.get(cacheKey);
  if (hit && now - hit.at < LIVE_TTL_MS) return hit.models;
  const { fetchCustomProviderModels } = await import(
    "@/lib/provider_model_fetchers"
  );
  // Bounded: a dead address must not hold up the model list.
  const models = Promise.race([
    fetchCustomProviderModels(providerId, baseUrl, apiKey, wire).catch(
      () => [] as LanguageModel[],
    ),
    new Promise<LanguageModel[]>((resolve) =>
      setTimeout(() => resolve([]), 4_000).unref?.(),
    ),
  ]);
  liveCache.set(cacheKey, { at: now, models });
  return models;
}

export async function getLanguageModels({
  providerId,
  live = true,
}: {
  providerId: string;
  /** For a provider the user added: also ask its endpoint (cached). */
  live?: boolean;
}): Promise<LanguageModel[]> {
  const allProviders = await getLanguageModelProviders();
  const provider = allProviders.find((p) => p.id === providerId);

  if (!provider) {
    console.warn(`Provider with ID "${providerId}" not found.`);
    return [];
  }

  if (providerId === COMPASS_PROVIDER_ID) {
    return getCompassSyntheticModels();
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
      const { readSettings } = await import("@/main/settings");
      const settings = readSettings();
      const fromSettings = (
        settings.providerSettings?.[providerId]?.apiKey?.value ?? ""
      ).trim();
      apiKey =
        (fromSettings || undefined) ??
        (await getProviderApiKey(providerId)) ??
        (provider.envVarName ? getEnvVar(provider.envVarName) : undefined);
    } catch {
      // DB / settings not available (e.g. wrong process)
    }

    if (!apiKey) {
      // No API key: return 0 models (like OpenRouter). Do not show hardcoded models.
      cloudModels = [];
    } else {
      // ONE path for every cloud provider — see `mergeByApiName` for why the
      // catalog is the floor rather than a fallback. Both sources are
      // independently best-effort, so neither can empty the list on its own.
      const [catalog, native] = await Promise.all([
        getModelsFromModelsDev(providerId).catch((error) => {
          console.warn(
            `[models.dev] Failed to fetch models for "${providerId}":`,
            error,
          );
          return [] as LanguageModel[];
        }),
        // Providers with no native fetcher resolve to [] without a request.
        // `elastic` is the inverse case: it has NO catalog rows (it lists
        // Kibana agents from a self-hosted instance, not models), so native is
        // its only source and the empty floor is correct.
        fetchModelsFromProvider(providerId, apiKey, provider.apiBaseUrl).catch(
          (error) => {
            console.warn(
              `[${providerId}] Native fetch failed, using catalog:`,
              error,
            );
            return [] as LanguageModel[];
          },
        ),
      ]);
      cloudModels = mergeByApiName(catalog, native);
    }
  }

  // A provider the user added: its endpoint's live list, beside any models
  // typed in by hand (QA #25: a keyless Ollama /v1 listed none).
  if (live && provider.type === "custom" && provider.apiBaseUrl) {
    let key: string | undefined;
    try {
      const { readSettings } = await import("@/main/settings");
      key = readSettings().providerSettings?.[providerId]?.apiKey?.value;
    } catch {
      // settings not available in this process
    }
    const listed = await liveCustomModels(providerId, provider.apiBaseUrl, key, Date.now(), {
      apiFormat: provider.apiFormat,
      authHeader: provider.authHeader,
    });
    const typed = new Set(customModels.map((m) => m.apiName));
    return [...customModels, ...listed.filter((m) => !typed.has(m.apiName))];
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

  return stampDeepThinkingSupport(modelsByProvider);
}

/**
 * Answer "can this model reason?" HERE, in main, and ship the answer.
 *
 * The Deep-thinking toggle is gated from the renderer, which has neither input it
 * needs: `registerModelsDevReasoning` is called from `models_dev.ts` (a main-only
 * module — it imports `node:fs` and `electron`), and the Core tier→vendor routing map
 * is written only by `core-model-overrides.ts` (likewise main-only, with a build-time
 * env fallback that Vite defines for the main bundle alone). In the renderer both
 * lookups returned empty for EVERY model, so the gate always fell through to the
 * legacy `PROVIDERS_THAT_SUPPORT_THINKING` allowlist — which is why Atlarix Core, a
 * synthetic provider no allowlist names, never showed the toggle while the very same
 * model on BYOK did.
 *
 * Riding this payload rather than a new IPC channel is deliberate: the picker and
 * `useAtlarixCoreCatalog` already read it, and it is already invalidated on
 * `core-models:changed` and provider CRUD — so a Core lineup change updates the
 * toggle with no extra wiring, and no channel needs allowlisting in `preload.ts`.
 *
 * Exported only so a test can drive THIS function rather than a copy of it: the
 * defect worth catching is a call site that stops resolving Core tiers, and a
 * test that rebuilds the call itself would keep passing through exactly that.
 */
export function stampDeepThinkingSupport(
  modelsByProvider: Record<string, LanguageModel[]>,
): Record<string, LanguageModel[]> {
  for (const [providerId, models] of Object.entries(modelsByProvider)) {
    modelsByProvider[providerId] = models.map((model) => ({
      ...model,
      supportsDeepThinking: isReasoningCapableModel({
        name: model.apiName,
        provider: providerId,
      }),
      // /effort's levels for this model, on the same payload for the same
      // reasons (catalog and Core routing are main-process state).
      effortChoices:
        effortChoicesForModel({ name: model.apiName, provider: providerId }) ?? undefined,
      // AUDIO input rides the same payload for the same reasons: the modality
      // registry is main-process state, and this row is already invalidated on
      // provider CRUD and `core-models:changed`, so the mic follows a lineup
      // change with no extra wiring and no new allowlisted channel.
      //
      // RESOLVED THROUGH THE CORE TIER→VENDOR MAP, not passed raw. For an Atlarix
      // Core row the provider is the synthetic `compass` and the name is a tier id
      // (`core-1`), and the catalog has a row for neither — so `(compass, core-1)`
      // misses every lookup and returns false for the entire Core lineup, exactly
      // the bug this payload exists to fix for Deep thinking. These two resolvers
      // are what `isReasoningCapableModel` uses one line up; they are named for
      // reasoning but do nothing reasoning-specific, and sharing them is what keeps
      // the two gates from drifting apart on the next lineup change.
      supportsAudioInput: detectAudioCapability(
        resolveCapabilityProviderId({
          provider: providerId,
          name: model.apiName,
        }),
        resolveReasoningCatalogModelId({
          provider: providerId,
          name: model.apiName,
        }),
      ),
    }));
  }
  return modelsByProvider;
}

export function isCustomProvider({ providerId }: { providerId: string }) {
  return providerId.startsWith(CUSTOM_PROVIDER_PREFIX);
}

export const CUSTOM_PROVIDER_PREFIX = "custom::";
