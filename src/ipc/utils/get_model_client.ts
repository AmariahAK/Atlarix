import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI as createGoogle } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { createVertex as createGoogleVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import { LanguageModelV2 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type {
  LargeLanguageModel,
  UserSettings,
  VertexProviderSetting,
  AzureProviderSetting,
} from "../../lib/schemas";

/**
 * When Auto is ON and user has configured a provider with at least 2 favorite models,
 * returns { provider: 'auto', name: 'auto' } so getModelClient builds the Fast/Medium/Thinking chain.
 * Otherwise returns the selected model for manual mode.
 */
export function getEffectiveModel(settings: UserSettings): LargeLanguageModel {
  if (
    settings.autoModelRouting &&
    settings.autoProviderId &&
    Array.isArray(settings.autoModelIds) &&
    settings.autoModelIds.length >= 2
  ) {
    return { provider: "auto", name: "auto" };
  }
  return settings.selectedModel;
}

/**
 * Returns the model to use for token/temperature options (must resolve to a real model).
 * When Auto is ON, uses the first model in the auto chain; otherwise selectedModel.
 */
export function getEffectiveModelForOptions(settings: UserSettings): LargeLanguageModel {
  if (
    settings.autoModelRouting &&
    settings.autoProviderId &&
    Array.isArray(settings.autoModelIds) &&
    settings.autoModelIds.length >= 2
  ) {
    return {
      provider: settings.autoProviderId,
      name: settings.autoModelIds[0],
    };
  }
  return settings.selectedModel;
}

/** OpenRouter model IDs that return 404 (moved/renamed). Map to user's first favorite or a known-good model. */
const DEPRECATED_OPENROUTER_MODEL_IDS = new Set([
  "pony-alpha",
  "openrouter/pony-alpha",
  "z-ai/pony-alpha",
]);

/**
 * Returns the "fast" model for the current provider: Auto's first model, or manual's first favorite.
 * Used for summarization, diagram fallback, and any flow that should use the user's chosen fast model.
 * Pass openRouterFavoriteIds when caller has them (e.g. diagram handler); for OpenRouter manual mode.
 */
export function getFastModelForCurrentProvider(
  settings: UserSettings,
  openRouterFavoriteIds?: string[],
): LargeLanguageModel | null {
  if (
    settings.autoModelRouting &&
    settings.autoProviderId &&
    Array.isArray(settings.autoModelIds) &&
    settings.autoModelIds.length >= 1 &&
    settings.autoModelIds[0]
  ) {
    return { provider: settings.autoProviderId, name: settings.autoModelIds[0] };
  }
  const effective = settings.selectedModel;
  if (!effective?.provider) return null;
  if (effective.provider === "openrouter" && openRouterFavoriteIds?.length) {
    return { provider: "openrouter", name: openRouterFavoriteIds[0] };
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
 * Resolves the model used for diagram generation. When Auto is ON, uses Auto chain;
 * when manual and OpenRouter model is known-deprecated, uses first OpenRouter favorite if provided.
 */
export function getDiagramModelConfig(
  settings: UserSettings,
  openRouterFavoriteIds?: string[],
): LargeLanguageModel {
  const effective = getEffectiveModel(settings);
  if (effective.provider === "openrouter" && typeof effective.name === "string") {
    const name = effective.name.split("/").pop() ?? effective.name;
    if (DEPRECATED_OPENROUTER_MODEL_IDS.has(effective.name) || DEPRECATED_OPENROUTER_MODEL_IDS.has(name)) {
      if (openRouterFavoriteIds?.length) {
        return { provider: "openrouter", name: openRouterFavoriteIds[0] };
      }
      return effective;
    }
  }
  return effective;
}

/**
 * Returns a fallback model for diagram generation when the current model returns 404.
 * Uses user's chosen "fast" model for current provider (Auto first model, or first favorite for OpenRouter/Ollama/LM Studio).
 */
export function getDiagramFallbackModel(
  settings: UserSettings,
  openRouterFavoriteIds?: string[],
): LargeLanguageModel | null {
  if (
    settings.autoModelRouting &&
    settings.autoProviderId &&
    Array.isArray(settings.autoModelIds) &&
    settings.autoModelIds.length >= 2
  ) {
    return { provider: "auto", name: "auto" };
  }
  return getFastModelForCurrentProvider(settings, openRouterFavoriteIds);
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
import { FREE_OPENROUTER_MODEL_NAMES } from "../shared/language_model_constants";
import { getLanguageModelProviders } from "../shared/language_model_helpers";
import { getProviderApiKey } from "../shared/provider_api_keys";
import { LanguageModelProvider } from "../ipc_types";
import { createAtlarixEngine } from "./llm_engine_provider";

import { LM_STUDIO_BASE_URL } from "./lm_studio_utils";
import { createOllamaProvider } from "./ollama_provider";
import { getOllamaApiUrl } from "../handlers/local_model_ollama_handler";
import { createFallback } from "./fallback_ai_model";

const dyadEngineUrl = process.env.DYAD_ENGINE_URL;

/** Default model per provider when using "Auto" (matches AI Providers grid). */
const AUTO_MODELS = [
  { provider: "google", name: "gemini-2.5-flash" },
  { provider: "openrouter", name: "qwen/qwen3-coder:free" },
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

const logger = log.scope("getModelClient");
export async function getModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  // files?: File[],
): Promise<{
  modelClient: ModelClient;
  isEngineEnabled?: boolean;
  isSmartContextEnabled?: boolean;
}> {
  const allProviders = await getLanguageModelProviders();

  const dyadApiKey = settings.providerSettings?.auto?.apiKey?.value;

  // --- Handle specific provider ---
  const providerConfig = allProviders.find((p) => p.id === model.provider);

  if (!providerConfig) {
    throw new Error(`Configuration not found for provider: ${model.provider}`);
  }

  // Handle Atlarix Pro override
  if (dyadApiKey && settings.enableAtlarixPro) {
    // Check if the selected provider supports Atlarix Pro (has a gateway prefix) OR
    // we're using local engine.
    // IMPORTANT: some providers like OpenAI have an empty string gateway prefix,
    // so we do a nullish and not a truthy check here.
    if (providerConfig.gatewayPrefix != null || dyadEngineUrl) {
      const enableSmartFilesContext = settings.enableProSmartFilesContextMode;
      const provider = createAtlarixEngine({
        apiKey: dyadApiKey,
        baseURL: dyadEngineUrl ?? "https://engine.atlarix.dev/v1",
        originalProviderId: model.provider,
        dyadOptions: {
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
        `\x1b[1;30;42m Using Atlarix Pro engine: ${dyadEngineUrl ?? "<prod>"} \x1b[0m`,
      );

      // Do not use free variant (for openrouter).
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
  // Handle 'auto' provider: build fallback chain so we try next provider on failure (Phase 6)
  if (model.provider === "auto") {
    if (model.name === "free") {
      const openRouterProvider = allProviders.find(
        (p) => p.id === "openrouter",
      );
      if (!openRouterProvider) {
        throw new Error("OpenRouter provider not found");
      }
      return {
        modelClient: {
          model: createFallback({
            models: await Promise.all(
              FREE_OPENROUTER_MODEL_NAMES.map(async (name: string) => {
                const { modelClient } = await getRegularModelClient(
                  { provider: "openrouter", name },
                  settings,
                  openRouterProvider,
                );
                return modelClient.model;
              }),
            ),
          }),
          builtinProviderId: "openrouter",
        },
        isEngineEnabled: false,
      };
    }
    // v2.1: When user configured one provider + 2 or 3 models (Fast/Medium/Thinking), use that
    const autoProviderId = settings.autoProviderId ?? null;
    const autoModelIds = settings.autoModelIds;
    if (
      autoProviderId &&
      Array.isArray(autoModelIds) &&
      autoModelIds.length >= 2
    ) {
      const providerInfo = allProviders.find((p) => p.id === autoProviderId);
      if (providerInfo) {
        const models: import("@ai-sdk/provider").LanguageModelV2[] = [];
        const modelNames = autoModelIds.slice(0, 3); // support 2 or 3
        for (const modelName of modelNames) {
          try {
            const { modelClient } = await getModelClient(
              { provider: autoProviderId, name: modelName },
              settings,
            );
            models.push(modelClient.model);
          } catch (err) {
            logger.warn(
              `Skip ${autoProviderId}/${modelName} for Auto: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        if (models.length > 0) {
          logger.log(
            `Auto: using provider ${autoProviderId} with ${models.length} model(s) (Fast/Medium/Thinking)`,
          );
          return {
            modelClient: {
              model: createFallback({ models }),
              builtinProviderId: autoProviderId,
            },
            isEngineEnabled: false,
          };
        }
      }
    }
    // Fallback: default provider order
    const order = DEFAULT_AUTO_PROVIDER_ORDER;
    const models: import("@ai-sdk/provider").LanguageModelV2[] = [];
    for (const providerId of order) {
      const modelName = AUTO_MODEL_BY_PROVIDER.get(providerId);
      if (!modelName) continue;
      const providerInfo = allProviders.find((p) => p.id === providerId);
      if (!providerInfo) continue;
      const envVarName = providerInfo.envVarName;
      const apiKey =
        settings.providerSettings?.[providerId]?.apiKey?.value ||
        (envVarName ? getEnvVar(envVarName) : undefined);
      if (!apiKey) continue;
      try {
        const { modelClient } = await getModelClient(
          { provider: providerId, name: modelName },
          settings,
        );
        models.push(modelClient.model);
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
      `Auto: using fallback chain of ${models.length} provider(s). First: ${order[0]}`,
    );
    return {
      modelClient: {
        model: createFallback({ models }),
        builtinProviderId: order[0],
      },
      isEngineEnabled: false,
    };
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
          model: provider(model.name),
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
    case "openrouter": {
      const provider = createOpenRouter({ apiKey });
      return {
        modelClient: {
          model: provider(model.name),
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
      const provider = createAmazonBedrock({
        apiKey: apiKey,
        region: getEnvVar("AWS_REGION") || "us-east-1",
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
