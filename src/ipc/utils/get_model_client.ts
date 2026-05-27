import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI as createGoogle } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { createVertex as createGoogleVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import { LanguageModelV2 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { OPENROUTER_APP_HEADERS } from "../shared/openrouter_app_headers";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createElasticAgentBuilderModel } from "./elastic_agent_builder_adapter";
import { createCohereChatModel } from "./cohere_chat_adapter";
import type {
  LargeLanguageModel,
  UserSettings,
  VertexProviderSetting,
  AzureProviderSetting,
} from "../../lib/schemas";

/**
 * True when Auto routing should use configured tier models (not manual selectedModel).
 * Requires at least one non-empty model id in autoModelIds (Fast/Balanced/Thinking slots).
 */
export function hasAutoRoutingModelConfig(settings: UserSettings): boolean {
  if (!settings.autoModelRouting || !settings.autoProviderId) return false;
  const ids = settings.autoModelIds;
  if (!Array.isArray(ids)) return false;
  return ids.some((s) => typeof s === "string" && s.trim().length > 0);
}

/**
 * When Auto is ON and user has configured a provider with at least one tier model,
 * returns { provider: 'auto', name: 'auto' } so getModelClient builds the Fast/Medium/Thinking chain.
 * Otherwise returns the selected model for manual mode.
 */
export function getEffectiveModel(settings: UserSettings): LargeLanguageModel {
  if (hasAutoRoutingModelConfig(settings)) {
    return { provider: "auto", name: "auto" };
  }
  return settings.selectedModel;
}

/**
 * Returns the model to use for token/temperature options (must resolve to a real model).
 * When Auto is ON, uses the first configured tier model; otherwise selectedModel.
 */
export function getEffectiveModelForOptions(settings: UserSettings): LargeLanguageModel {
  if (hasAutoRoutingModelConfig(settings)) {
    const ids = settings.autoModelIds!;
    const first = ids.find((s) => typeof s === "string" && s.trim().length > 0);
    if (first) {
      return {
        provider: settings.autoProviderId!,
        name: first.trim(),
      };
    }
  }
  return settings.selectedModel;
}

/**
 * Returns the "fast" model for the current provider: Auto's first model, or manual's first favorite.
 * Used for summarization, diagram fallback, and any flow that should use the user's chosen fast model.
 */
export function getFastModelForCurrentProvider(
  settings: UserSettings,
  _openRouterFavoriteIds?: string[],
): LargeLanguageModel | null {
  const tier0 =
    Array.isArray(settings.autoModelIds) && typeof settings.autoModelIds[0] === "string"
      ? settings.autoModelIds[0].trim()
      : "";
  if (settings.autoModelRouting && settings.autoProviderId && tier0) {
    return { provider: settings.autoProviderId, name: tier0 };
  }
  const effective = settings.selectedModel;
  if (!effective?.provider) return null;
  if (effective.provider === "compass") {
    return { provider: "compass", name: COMPASS_TIER_FAST };
  }
  if (effective.provider === "openrouter" && effective.name?.trim()) {
    return { provider: "openrouter", name: effective.name.trim() };
  }
  const ollamaFavs = (settings.providerSettings?.ollama as { favoriteModelIds?: string[] })?.favoriteModelIds;
  if (effective.provider === "ollama" && ollamaFavs?.length) {
    return { provider: "ollama", name: ollamaFavs[0] };
  }
  const lmStudioFavs = (settings.providerSettings?.lmstudio as { favoriteModelIds?: string[] })?.favoriteModelIds;
  if (effective.provider === "lmstudio" && lmStudioFavs?.length) {
    return { provider: "lmstudio", name: lmStudioFavs[0] };
  }
  return null;
}

/**
 * v3.6: Returns the balanced (second-tier) model for summarization when session is complex.
 */
export function getBalancedModelForCurrentProvider(
  settings: UserSettings,
  _openRouterFavoriteIds?: string[],
): LargeLanguageModel | null {
  const tier1 =
    Array.isArray(settings.autoModelIds) && typeof settings.autoModelIds[1] === "string"
      ? settings.autoModelIds[1].trim()
      : "";
  if (settings.autoModelRouting && settings.autoProviderId && tier1) {
    return { provider: settings.autoProviderId, name: tier1 };
  }
  const effective = settings.selectedModel;
  if (!effective?.provider) return null;
  if (effective.provider === "compass") {
    return { provider: "compass", name: COMPASS_TIER_BALANCED };
  }
  if (effective.provider === "openrouter" && effective.name?.trim()) {
    return { provider: "openrouter", name: effective.name.trim() };
  }
  const ollamaFavs = (settings.providerSettings?.ollama as { favoriteModelIds?: string[] })?.favoriteModelIds;
  if (effective.provider === "ollama" && ollamaFavs && ollamaFavs.length >= 2) {
    return { provider: "ollama", name: ollamaFavs[1] };
  }
  const lmStudioFavs = (settings.providerSettings?.lmstudio as { favoriteModelIds?: string[] })?.favoriteModelIds;
  if (effective.provider === "lmstudio" && lmStudioFavs && lmStudioFavs.length >= 2) {
    return { provider: "lmstudio", name: lmStudioFavs[1] };
  }
  return null;
}

/**
 * Returns the thinking (third-tier) model when Auto slots or Compass / favorites provide it.
 */
export function getThinkingModelForCurrentProvider(
  settings: UserSettings,
  _openRouterFavoriteIds?: string[],
): LargeLanguageModel | null {
  const tier2 =
    Array.isArray(settings.autoModelIds) && typeof settings.autoModelIds[2] === "string"
      ? settings.autoModelIds[2].trim()
      : "";
  if (settings.autoModelRouting && settings.autoProviderId && tier2) {
    return { provider: settings.autoProviderId, name: tier2 };
  }
  const effective = settings.selectedModel;
  if (!effective?.provider) return null;
  if (effective.provider === "compass") {
    return { provider: "compass", name: COMPASS_TIER_THINKING };
  }
  if (effective.provider === "openrouter" && effective.name?.trim()) {
    return { provider: "openrouter", name: effective.name.trim() };
  }
  const ollamaFavs = (settings.providerSettings?.ollama as { favoriteModelIds?: string[] })?.favoriteModelIds;
  if (effective.provider === "ollama" && ollamaFavs && ollamaFavs.length >= 3) {
    return { provider: "ollama", name: ollamaFavs[2] };
  }
  const lmStudioFavs = (settings.providerSettings?.lmstudio as { favoriteModelIds?: string[] })?.favoriteModelIds;
  if (effective.provider === "lmstudio" && lmStudioFavs && lmStudioFavs.length >= 3) {
    return { provider: "lmstudio", name: lmStudioFavs[2] };
  }
  return null;
}

/**
 * Resolves the model used for diagram generation. When Auto is ON, uses Auto chain.
 */
export function getDiagramModelConfig(
  settings: UserSettings,
  _openRouterFavoriteIds?: string[],
): LargeLanguageModel {
  return getEffectiveModel(settings);
}

/**
 * Returns a fallback model for diagram generation when the current model returns 404.
 * Uses user's chosen "fast" model for current provider (Auto first model, or first favorite for OpenRouter/Ollama/LM Studio).
 */
export function getDiagramFallbackModel(
  settings: UserSettings,
  _openRouterFavoriteIds?: string[],
): LargeLanguageModel | null {
  if (hasAutoRoutingModelConfig(settings)) {
    return { provider: "auto", name: "auto" };
  }
  return getFastModelForCurrentProvider(settings);
}

/** True if the error indicates model not found (404) so diagram can retry with fallback. */
export function isDiagramModelNotFoundError(error: unknown): boolean {
  const code =
    (error as { statusCode?: number })?.statusCode ??
    (error as { status?: number })?.status;
  if (code === 404) return true;
  const msg = String((error as Error)?.message ?? "").toLowerCase();
  return msg.includes("not found") || msg.includes("404") || msg.includes("model not found");
}
import { getEnvVar } from "./read_env";
import log from "electron-log";
import { getLanguageModelProviders } from "../shared/language_model_helpers";
import { getProviderApiKey } from "../shared/provider_api_keys";
import { LanguageModelProvider } from "../ipc_types";
import { createAtlarixEngine } from "./llm_engine_provider";
import {
  COMPASS_TIER_BALANCED,
  COMPASS_TIER_FAST,
  COMPASS_TIER_THINKING,
  compassFallbackChain,
  getCompassMasterApiKey,
  getOpenRouterModelIdForCompassTier,
} from "../shared/compass_constants";
import { SubscriptionManager } from "../../lib/SubscriptionManager";

import { LM_STUDIO_BASE_URL } from "./lm_studio_utils";
import { createOllamaProvider } from "./ollama_provider";
import { getOllamaApiUrl } from "../handlers/local_model_ollama_handler";
import { createFallback } from "./fallback_ai_model";
import { resolveContextBudgetTier } from "../../lib/routing/context_budget_routing";

/** Primary: `ATLARIX_ENGINE_URL`. Deprecated alias: `DYAD_ENGINE_URL`. */
const atlarixEngineUrl =
  process.env.ATLARIX_ENGINE_URL ?? process.env.DYAD_ENGINE_URL;

/** Default model per provider when using "Auto" (Compass first when key present — usage + product default). */
const AUTO_MODELS = [
  { provider: "compass", name: COMPASS_TIER_FAST },
  { provider: "openrouter", name: "openai/gpt-4o-mini" },
  { provider: "google", name: "gemini-2.5-flash" },
  { provider: "anthropic", name: "claude-sonnet-4-20250514" },
  { provider: "openai", name: "gpt-4.1" },
  { provider: "xai", name: "grok-2-1212" },
  { provider: "togetherai", name: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { provider: "groq", name: "llama-3.3-70b-versatile" },
  { provider: "mistral", name: "mistral-large-latest" },
  { provider: "ollama", name: "llama3.2" },
  { provider: "lmstudio", name: "local" },
];

const DEFAULT_AUTO_PROVIDER_ORDER = AUTO_MODELS.map((m) => m.provider);
const AUTO_MODEL_BY_PROVIDER = new Map(
  AUTO_MODELS.map((m) => [m.provider, m.name] as const)
);

export interface ModelClient {
  model: LanguageModelV2;
  builtinProviderId?: string;
}

/** Role-aware tier selection for Auto (Fast=0, Balanced=1, Thinking=2). */
export interface GetModelClientOptions {
  /** @deprecated Ignored — unified runtime uses role/depth only. */
  agentMode?: "direct" | "guided" | "autonomous";
  delegationRole?: "main" | "agent" | "subagent";
  delegationDepth?: number;
  complexityBump?: boolean;
}

/** Main and depth-0 agents use Balanced; nested subagents use Fast. */
function getAutoTierIndex(
  _settings: UserSettings,
  options: GetModelClientOptions | undefined,
): number {
  const role = options?.delegationRole ?? "main";
  const depth = options?.delegationDepth ?? 0;

  if (role === "main") return 1;
  if (role === "agent") {
    return options?.complexityBump ? 1 : depth === 0 ? 1 : 0;
  }
  return 0;
}

const logger = log.scope("getModelClient");
export async function getModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  options?: GetModelClientOptions,
): Promise<{
  modelClient: ModelClient;
  isEngineEnabled?: boolean;
  isSmartContextEnabled?: boolean;
}> {
  const allProviders = await getLanguageModelProviders();

  const atlarixProApiKey = settings.providerSettings?.auto?.apiKey?.value;

  // Synthetic "auto" is not in allProviders — must run before providerConfig lookup
  // Handle 'auto' provider: build fallback chain so we try next provider on failure (Phase 6)
  if (model.provider === "auto") {
    if (model.name === "free") {
      const compassProvider = allProviders.find((p) => p.id === "compass");
      if (!compassProvider || !getCompassMasterApiKey()) {
        throw new Error(
          "Atlarix Core is not available. Configure release credentials or add API keys in Settings.",
        );
      }
      const { modelClient } = await getRegularModelClient(
        { provider: "compass", name: COMPASS_TIER_FAST },
        settings,
        compassProvider,
      );
      return {
        modelClient: {
          model: modelClient.model,
          builtinProviderId: "compass",
        },
        isEngineEnabled: false,
      };
    }
    // v2.1: When user configured one provider + 1–3 models (Fast/Medium/Thinking), use that
    const autoProviderId = settings.autoProviderId ?? null;
    const autoModelIds = settings.autoModelIds;
    const slots = Array.isArray(autoModelIds)
      ? ([0, 1, 2] as const).map((i) => {
          const s = autoModelIds[i];
          return typeof s === "string" && s.trim().length > 0 ? s.trim() : "";
        })
      : ["", "", ""];
    const hasAnySlot = slots.some(Boolean);
    if (autoProviderId && hasAnySlot) {
      const providerInfo = allProviders.find((p) => p.id === autoProviderId);
      if (providerInfo) {
        const firstTier = getAutoTierIndex(settings, options);
        const orderedNames: string[] = [];
        const pushUnique = (name: string) => {
          if (name && !orderedNames.includes(name)) orderedNames.push(name);
        };
        pushUnique(slots[firstTier]);
        for (let i = 0; i < 3; i++) {
          if (i !== firstTier) pushUnique(slots[i]);
        }
        const models: import("@ai-sdk/provider").LanguageModelV2[] = [];
        let firstBuiltinInChain: string | undefined;
        for (const modelName of orderedNames) {
          try {
            const { modelClient } = await getModelClient(
              { provider: autoProviderId, name: modelName },
              settings,
            );
            models.push(modelClient.model);
            if (firstBuiltinInChain === undefined) {
              firstBuiltinInChain = modelClient.builtinProviderId ?? autoProviderId;
            }
          } catch (err) {
            logger.warn(
              `Skip ${autoProviderId}/${modelName} for Auto: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        if (models.length > 0) {
          logger.log(
            `Auto: using provider ${autoProviderId} with ${models.length} model(s), first tier=${firstTier} (0=Fast,1=Balanced,2=Thinking)`,
          );
          return {
            modelClient: {
              model: createFallback({ models }),
              builtinProviderId: firstBuiltinInChain ?? autoProviderId,
            },
            isEngineEnabled: false,
          };
        }
      }
    }
    // Fallback: default provider order (first successful provider sets metering / builtin id)
    const order = DEFAULT_AUTO_PROVIDER_ORDER;
    const models: import("@ai-sdk/provider").LanguageModelV2[] = [];
    let firstProviderInChain: string | undefined;
    for (const providerId of order) {
      const modelName = AUTO_MODEL_BY_PROVIDER.get(providerId);
      if (!modelName) continue;
      const providerInfo = allProviders.find((p) => p.id === providerId);
      if (!providerInfo) continue;
      const envVarName = providerInfo.envVarName;
      let apiKey =
        settings.providerSettings?.[providerId]?.apiKey?.value ||
        (envVarName ? getEnvVar(envVarName) : undefined);
      if (providerId === "compass") {
        apiKey = getCompassMasterApiKey();
      }
      if (!apiKey) continue;
      try {
        const { modelClient } = await getModelClient(
          { provider: providerId, name: modelName },
          settings,
        );
        models.push(modelClient.model);
        if (firstProviderInChain === undefined) {
          firstProviderInChain = modelClient.builtinProviderId ?? providerId;
        }
      } catch (err) {
        logger.warn(
          `Skip ${providerId} for Auto fallback: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (models.length === 0) {
      throw new Error(
        "No API keys available for any model supported by the 'auto' provider. Set API keys in Settings or configure Auto provider + 3 models in Config.",
      );
    }
    logger.log(
      `Auto: using fallback chain of ${models.length} provider(s). First in chain: ${firstProviderInChain ?? "?"}`,
    );
    return {
      modelClient: {
        model: createFallback({ models }),
        builtinProviderId: firstProviderInChain ?? order[0],
      },
      isEngineEnabled: false,
    };
  }

  // --- Handle specific provider ---
  const providerConfig = allProviders.find((p) => p.id === model.provider);

  if (!providerConfig) {
    throw new Error(`Configuration not found for provider: ${model.provider}`);
  }

  // Handle Atlarix Pro override (Compass uses its own managed key, never the engine proxy)
  if (
    model.provider !== "compass" &&
    atlarixProApiKey &&
    settings.enableAtlarixPro
  ) {
    // Check if the selected provider supports Atlarix Pro (has a gateway prefix) OR
    // we're using local engine.
    // IMPORTANT: some providers like OpenAI have an empty string gateway prefix,
    // so we do a nullish and not a truthy check here.
    if (providerConfig.gatewayPrefix != null || atlarixEngineUrl) {
      const enableSmartFilesContext = settings.enableProSmartFilesContextMode;
      const includeExtendedThinking =
        resolveContextBudgetTier(model, settings) === "thinking";
      const provider = createAtlarixEngine({
        apiKey: atlarixProApiKey,
        baseURL: atlarixEngineUrl ?? "https://engine.atlarix.dev/v1",
        originalProviderId: model.provider,
        includeExtendedThinking,
        atlarixEngineOptions: {
          enableLazyEdits:
            settings.selectedChatMode === "ask"
              ? false
              : settings.enableProLazyEditsMode &&
              settings.proLazyEditsMode !== "v2",
          enableSmartFilesContext,
          enableWebSearch: settings.enableProWebSearch,
        },
        settings,
      });

      logger.info(
        `\x1b[1;97;44m Using Atlarix Pro API key for model: ${model.name} \x1b[0m`,
      );

      logger.info(
        `\x1b[1;30;42m Using Atlarix Pro engine: ${atlarixEngineUrl ?? "<prod>"} \x1b[0m`,
      );

      const modelName = model.name.split(":free")[0];
      const autoModelClient = {
        model: provider(`${providerConfig.gatewayPrefix || ""}${modelName}`),
        builtinProviderId: model.provider,
      };

      return {
        modelClient: autoModelClient,
        isEngineEnabled: true,
        isSmartContextEnabled: enableSmartFilesContext,
      };
    } else {
      logger.warn(
        `Atlarix Pro enabled, but provider ${model.provider} does not have a gateway prefix defined. Falling back to direct provider connection.`,
      );
      // Fall through to regular provider logic if gateway prefix is missing
    }
  }

  return await getRegularModelClient(model, settings, providerConfig);
}

async function getRegularModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  providerConfig: LanguageModelProvider,
): Promise<{
  modelClient: ModelClient;
  backupModelClients: ModelClient[];
}> {
  // Get API key for the specific provider
  // Priority: settings -> database -> env (so UI/database key wins over .env)
  let apiKey =
    settings.providerSettings?.[model.provider]?.apiKey?.value;

  if (!apiKey) {
    const dbApiKey = await getProviderApiKey(model.provider);
    if (dbApiKey) {
      apiKey = dbApiKey;
      logger.info(`[API Key] Loaded ${model.provider} API key from database`);
    }
  }
  if (!apiKey && providerConfig.envVarName) {
    apiKey = getEnvVar(providerConfig.envVarName);
  }

  const providerId = providerConfig.id;
  // Create client based on provider ID or type
  switch (providerId) {
    case "openai": {
      const provider = createOpenAI({ apiKey });
      return {
        modelClient: {
          model: provider.responses(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "anthropic": {
      const provider = createAnthropic({ apiKey });
      return {
        modelClient: {
          model: provider(model.name) as unknown as LanguageModelV2,
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "xai": {
      const provider = createXai({ apiKey });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "google": {
      const provider = createGoogle({ apiKey });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "vertex": {
      // Vertex uses Google service account credentials with project/location
      const vertexSettings = settings.providerSettings?.[
        model.provider
      ] as VertexProviderSetting;
      const project = vertexSettings?.projectId;
      const location = vertexSettings?.location;
      const serviceAccountKey = vertexSettings?.serviceAccountKey?.value;

      // Use a baseURL that does NOT pin to publishers/google so that
      // full publisher model IDs (e.g. publishers/deepseek-ai/models/...) work.
      const regionHost = `${location === "global" ? "" : `${location}-`}aiplatform.googleapis.com`;
      const baseURL = `https://${regionHost}/v1/projects/${project}/locations/${location}`;
      const provider = createGoogleVertex({
        project,
        location,
        baseURL,
        googleAuthOptions: serviceAccountKey
          ? {
            // Expecting the user to paste the full JSON of the service account key
            credentials: JSON.parse(serviceAccountKey),
          }
          : undefined,
      });
      return {
        modelClient: {
          // For built-in Google models on Vertex, the path must include
          // publishers/google/models/<model>. For partner MaaS models the
          // full publisher path is already included.
          model: provider(
            model.name.includes("/")
              ? model.name
              : `publishers/google/models/${model.name}`,
          ),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "compass": {
      const masterKey = getCompassMasterApiKey();
      if (!masterKey) {
        throw new Error(
          "Atlarix Core is not configured for this build. Add your own API keys in Settings or use a release build.",
        );
      }
      const eff = SubscriptionManager.getEffectiveTier();
      const chain = compassFallbackChain(model.name, eff);
      const or = createOpenRouter({
        apiKey: masterKey,
        headers: { ...OPENROUTER_APP_HEADERS },
      });
      const models: LanguageModelV2[] = [];
      for (const tierId of chain) {
        const openRouterModelId = getOpenRouterModelIdForCompassTier(tierId);
        if (!openRouterModelId) {
          logger.warn(`[Compass] Missing env model for tier ${tierId}`);
          continue;
        }
        models.push(or(openRouterModelId));
      }
      if (models.length === 0) {
        throw new Error(
          "Atlarix Core model configuration is incomplete. Set COMPASS_MODEL_FAST (and BALANCED/THINKING for Pro) in the build environment.",
        );
      }
      return {
        modelClient: {
          model: models.length === 1 ? models[0]! : createFallback({ models }),
          builtinProviderId: "compass",
        },
        backupModelClients: [],
      };
    }
    case "openrouter": {
      if (!apiKey) {
        throw new Error(
          "OpenRouter API key required. Add it under Settings → OpenRouter (BYOK) or set OPENROUTER_API_KEY.",
        );
      }
      const or = createOpenRouter({
        apiKey,
        headers: { ...OPENROUTER_APP_HEADERS },
      });
      return {
        modelClient: {
          model: or(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "azure": {
      // Check if we're in e2e testing mode
      const testAzureBaseUrl = getEnvVar("TEST_AZURE_BASE_URL");

      if (testAzureBaseUrl) {
        // Use fake server for e2e testing
        logger.info(`Using test Azure base URL: ${testAzureBaseUrl}`);
        const provider = createOpenAICompatible({
          name: "azure-test",
          baseURL: testAzureBaseUrl,
          apiKey: "fake-api-key-for-testing",
        });
        return {
          modelClient: {
            model: provider(model.name),
            builtinProviderId: providerId,
          },
          backupModelClients: [],
        };
      }

      const azureSettings = settings.providerSettings?.azure as
        | AzureProviderSetting
        | undefined;
      const azureApiKeyFromSettings = (
        azureSettings?.apiKey?.value ?? ""
      ).trim();
      const azureResourceNameFromSettings = (
        azureSettings?.resourceName ?? ""
      ).trim();
      const envResourceName = (getEnvVar("AZURE_RESOURCE_NAME") ?? "").trim();
      const envAzureApiKey = (getEnvVar("AZURE_API_KEY") ?? "").trim();

      const resourceName = azureResourceNameFromSettings || envResourceName;
      const azureApiKey = azureApiKeyFromSettings || envAzureApiKey;

      if (!resourceName) {
        throw new Error(
          "Azure OpenAI resource name is required. Provide it in Settings or set the AZURE_RESOURCE_NAME environment variable.",
        );
      }

      if (!azureApiKey) {
        throw new Error(
          "Azure OpenAI API key is required. Provide it in Settings or set the AZURE_API_KEY environment variable.",
        );
      }

      const provider = createAzure({
        resourceName,
        apiKey: azureApiKey,
      });

      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "ollama": {
      const provider = createOllamaProvider({ baseURL: getOllamaApiUrl() });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "lmstudio": {
      // LM Studio uses OpenAI compatible API
      const baseURL = providerConfig.apiBaseUrl || LM_STUDIO_BASE_URL + "/v1";
      const provider = createOpenAICompatible({
        name: "lmstudio",
        baseURL,
      });
      return {
        modelClient: {
          model: provider(model.name),
        },
        backupModelClients: [],
      };
    }
    case "bedrock": {
      // AWS Bedrock supports API key authentication using AWS_BEARER_TOKEN_BEDROCK
      // See: https://sdk.vercel.ai/providers/ai-sdk-providers/amazon-bedrock#api-key-authentication
      const bedrockSettings = settings.providerSettings?.bedrock as { region?: string } | undefined;
      const region = bedrockSettings?.region || getEnvVar("AWS_REGION") || "us-east-1";
      const provider = createAmazonBedrock({
        apiKey: apiKey,
        region,
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "togetherai": {
      const provider = createOpenAICompatible({
        name: "togetherai",
        baseURL: "https://api.together.xyz/v1",
        apiKey,
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "groq": {
      const provider = createOpenAICompatible({
        name: "groq",
        baseURL: "https://api.groq.com/openai/v1",
        apiKey,
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "mistral": {
      const provider = createOpenAICompatible({
        name: "mistral",
        baseURL: "https://api.mistral.ai/v1",
        apiKey,
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "nvidia_nim": {
      const provider = createOpenAICompatible({
        name: "nvidia_nim",
        baseURL: "https://integrate.api.nvidia.com/v1",
        apiKey,
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "perplexity": {
      const provider = createOpenAICompatible({
        name: "perplexity",
        baseURL: "https://api.perplexity.ai",
        apiKey,
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "cerebras": {
      const provider = createOpenAICompatible({
        name: "cerebras",
        baseURL: "https://api.cerebras.ai/v1",
        apiKey,
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "cohere": {
      if (!apiKey) {
        throw new Error(
          "Cohere API key is required. Provide it in Settings or set COHERE_API_KEY.",
        );
      }
      const modelClient = createCohereChatModel({ apiKey, modelId: model.name });
      return {
        modelClient: {
          model: modelClient,
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "elastic": {
      const elasticSettings = settings.providerSettings?.elastic as
        | { apiKey?: { value?: string }; baseUrl?: string; space?: string }
        | undefined;
      const baseUrl = elasticSettings?.baseUrl?.trim();
      if (!baseUrl) {
        throw new Error(
          "Elastic Agent Builder requires Kibana URL. Set it in Settings > AI > Provider Settings (Elastic Agent Builder)."
        );
      }
      const elasticApiKey = apiKey || elasticSettings?.apiKey?.value;
      if (!elasticApiKey) {
        throw new Error(
          "Elastic Agent Builder requires an API key. Set it in Settings or set ELASTIC_AGENT_BUILDER_API_KEY."
        );
      }
      const elasticModel = createElasticAgentBuilderModel({
        baseUrl,
        apiKey: elasticApiKey,
        space: elasticSettings?.space?.trim(),
        agentId: model.name,
      });
      return {
        modelClient: {
          model: elasticModel,
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    default: {
      // Handle custom providers
      if (providerConfig.type === "custom") {
        if (!providerConfig.apiBaseUrl) {
          throw new Error(
            `Custom provider ${model.provider} is missing the API Base URL.`,
          );
        }
        // Assume custom providers are OpenAI compatible for now
        const provider = createOpenAICompatible({
          name: providerConfig.id,
          baseURL: providerConfig.apiBaseUrl,
          apiKey,
        });
        return {
          modelClient: {
            model: provider(model.name),
          },
          backupModelClients: [],
        };
      }
      // If it's not a known ID and not type 'custom', it's unsupported
      throw new Error(`Unsupported model provider: ${model.provider}`);
    }
  }
}
