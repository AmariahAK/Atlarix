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

/** User-selected model for each turn (no automatic tier routing). */
export function getEffectiveModel(settings: UserSettings): LargeLanguageModel {
  return settings.selectedModel;
}

/** Model used for token/temperature options. */
export function getEffectiveModelForOptions(settings: UserSettings): LargeLanguageModel {
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
  getCompassMasterApiKey,
  getOpenRouterModelIdForCompassTier,
} from "../shared/compass_constants";
import { SubscriptionManager } from "../../lib/SubscriptionManager";

import { LM_STUDIO_BASE_URL } from "./lm_studio_utils";
import { createOllamaProvider } from "./ollama_provider";
import { getOllamaApiUrl } from "../handlers/local_model_ollama_handler";
import { resolveContextBudgetTier } from "../../lib/routing/context_budget_routing";

/** Primary: `ATLARIX_ENGINE_URL`. Deprecated alias: `DYAD_ENGINE_URL`. */
const atlarixEngineUrl =
  process.env.ATLARIX_ENGINE_URL ?? process.env.DYAD_ENGINE_URL;

export interface ModelClient {
  model: LanguageModelV2;
  builtinProviderId?: string;
}

export interface GetModelClientOptions {
  /** @deprecated Ignored — unified runtime uses role/depth only. */
  agentMode?: "direct" | "guided" | "autonomous";
  delegationRole?: "main" | "agent" | "subagent";
  delegationDepth?: number;
  complexityBump?: boolean;
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

  if (model.provider === "auto") {
    throw new Error(
      "Automatic model routing was removed. Choose a model in chat settings or switch provider.",
    );
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
      const openRouterModelId = getOpenRouterModelIdForCompassTier(model.name);
      if (!openRouterModelId) {
        throw new Error(
          `Atlarix Core model "${model.name}" is not configured for this build. Choose another Core model or add BYOK keys in Settings.`,
        );
      }
      const or = createOpenRouter({
        apiKey: masterKey,
        headers: { ...OPENROUTER_APP_HEADERS },
      });
      return {
        modelClient: {
          model: or(openRouterModelId),
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
