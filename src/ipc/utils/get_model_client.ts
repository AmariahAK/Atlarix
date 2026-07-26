import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI as createGoogle } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { createVertex as createGoogleVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import { LanguageModelV2, LanguageModelV3 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { OPENROUTER_APP_HEADERS } from "../shared/openrouter_app_headers";
import {
  COMPASS_PROVIDER_ID,
  isCompassBuildConfigured,
} from "../shared/compass_constants";
import { OPENWEIGHT_PROVIDER_BASE_URLS } from "../shared/language_model_constants";
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

import { getEnvVar } from "./read_env";
import log from "electron-log";
import { getLanguageModelProviders } from "../shared/language_model_helpers";
import { getProviderApiKey } from "../shared/provider_api_keys";
import { LanguageModelProvider } from "../ipc_types";
import { createAtlarixEngine } from "./llm_engine_provider";
import {
  getCompassMasterApiKey,
  getCoreModelIdForCoreTier,
  getFirstConfiguredCoreTier,
  resolveConfiguredCoreTier,
} from "../shared/compass_constants";
import { getCoreProxyBaseUrl } from "../shared/core_proxy";
import { getSession } from "../../lib/auth/supabase-client";
import { LM_STUDIO_BASE_URL } from "./lm_studio_utils";
import { createOllamaProvider } from "./ollama_provider";
import { trackLocalModelConnected } from "@/main/lib/analytics";
import { getOllamaApiUrl } from "../handlers/local_model_ollama_handler";
import { hasNativeDeepThinkingSupport } from "../../lib/routing/reasoning-detector";

/** Primary: `ATLARIX_ENGINE_URL`. Deprecated alias: `DYAD_ENGINE_URL`. */
const atlarixEngineUrl =
  process.env.ATLARIX_ENGINE_URL ?? process.env.DYAD_ENGINE_URL;

export interface ModelClient {
  // ai@6: v3-spec providers are the norm; the two custom V2 adapters
  // (elastic/cohere) run via the SDK's compat wrapper, so both spec
  // versions are valid here.
  model: LanguageModelV2 | LanguageModelV3;
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

/** True if a provider has a usable API key (settings → DB → env). */
export async function hasUsableProviderKey(
  provider: string,
  settings: UserSettings,
  providerConfig: LanguageModelProvider,
): Promise<boolean> {
  // `settings` comes from readSettings(), which DECRYPTS each provider apiKey and
  // DROPS it entirely when decryption fails ("could not decrypt stored secrets",
  // settings.ts). So a present value here is already-decrypted plaintext — never
  // re-decrypt it (that would garbage-decode a plaintext string and break BYOK).
  // We require a non-empty (trimmed) value so an undecryptable→dropped key, or an
  // empty/whitespace value, correctly reads as "no key" and the Core fallback can
  // engage.
  const settingsKey = settings.providerSettings?.[provider]?.apiKey?.value;
  if (typeof settingsKey === "string" && settingsKey.trim()) return true;
  // DB path: deserializeApiKeyFromDb already returns undefined on decrypt failure.
  const dbKey = await getProviderApiKey(provider);
  if (typeof dbKey === "string" && dbKey.trim()) return true;
  if (providerConfig.envVarName) {
    const envKey = getEnvVar(providerConfig.envVarName);
    if (typeof envKey === "string" && envKey.trim()) return true;
  }
  return false;
}

export async function getModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  _options?: GetModelClientOptions,
): Promise<{
  modelClient: ModelClient;
  isEngineEnabled?: boolean;
  isSmartContextEnabled?: boolean;
  /** True when the selected provider had no usable key and we fell back to Atlarix Core. */
  fellBackToCore?: boolean;
}> {
  const allProviders = await getLanguageModelProviders();

  const atlarixProApiKey = settings.providerSettings?.auto?.apiKey?.value;

  if (model.provider === "auto") {
    throw new Error(
      "Automatic model routing was removed. Choose a model in chat settings or switch provider.",
    );
  }

  // --- Handle specific provider ---
  let providerConfig = allProviders.find((p) => p.id === model.provider);

  if (!providerConfig) {
    throw new Error(`Configuration not found for provider: ${model.provider}`);
  }

  // Resilience: if the selected model's provider has no usable API key, fall back
  // to Atlarix Core (the managed `compass` provider) when this build has it
  // configured — so the app stays usable instead of erroring. Never overrides a
  // provider that DOES have a key, and never re-routes Core itself.
  let fellBackToCore = false;
  if (process.env.ATLARIX_DIAG_146 === "1" && model.provider !== COMPASS_PROVIDER_ID) {
    const coreConfigured = isCompassBuildConfigured();
    const usable = await hasUsableProviderKey(model.provider, settings, providerConfig);
    logger.info(
      `[DIAG_146] core-fallback gate provider=${model.provider} coreConfigured=${coreConfigured} hasUsableKey=${usable} → ${coreConfigured && !usable ? "FALLBACK" : "no-fallback"}`,
    );
  }
  if (
    model.provider !== COMPASS_PROVIDER_ID &&
    isCompassBuildConfigured() &&
    !(await hasUsableProviderKey(model.provider, settings, providerConfig))
  ) {
    // Ask for the first CONFIGURED tier rather than assuming core-1 exists. The
    // lineup size is config-driven, so hardcoding core-1 meant that dropping the
    // tier-1 model turned this rescue path into a hard failure.
    const coreTier = getFirstConfiguredCoreTier();
    if (coreTier) {
      logger.info(
        `No usable API key for ${model.provider} — falling back to Atlarix Core (${coreTier}).`,
      );
      model = { name: coreTier, provider: COMPASS_PROVIDER_ID };
      const coreConfig = allProviders.find((p) => p.id === COMPASS_PROVIDER_ID);
      if (coreConfig) providerConfig = coreConfig;
      fellBackToCore = true;
    } else {
      logger.warn(
        `No usable API key for ${model.provider} and no Core model is configured — cannot fall back.`,
      );
    }
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
      const includeExtendedThinking = hasNativeDeepThinkingSupport(
        model,
        model.provider,
        settings,
      );
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

  return {
    ...(await getRegularModelClient(model, settings, providerConfig)),
    fellBackToCore,
  };
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
    case "compass": {
      // A selection can point at a slot the lineup no longer maps — persisted before
      // a lineup change, or a tier removed from core-models.json. Fall FORWARD to a
      // configured tier instead of failing the turn: otherwise changing the lineup
      // breaks every user whose saved selection pointed at the removed slot, on their
      // next message, with nothing they did wrong.
      const resolvedTier = resolveConfiguredCoreTier(model.name);
      if (!resolvedTier) {
        throw new Error(
          `No Atlarix Core model is configured for this build. Add your own API keys in Settings, or use a release build.`,
        );
      }
      if (resolvedTier.substituted) {
        logger.info(
          `Core tier "${model.name}" is not in the current lineup — using ${resolvedTier.tier}.`,
        );
        model = { ...model, name: resolvedTier.tier };
      }
      const coreModelId = getCoreModelIdForCoreTier(resolvedTier.tier);
      if (!coreModelId) {
        throw new Error(
          `Atlarix Core model "${model.name}" is not configured for this build. Choose another Core model or add BYOK keys in Settings.`,
        );
      }

      // Production path: route through the Atlarix Core proxy so the managed
      // provider key never ships in the client. We authenticate as the user with
      // their Supabase JWT; the proxy verifies entitlement, meters usage, and
      // forwards on the provider key (held server-side only).
      const proxyBaseUrl = getCoreProxyBaseUrl();
      if (proxyBaseUrl) {
        const session = await getSession();
        const accessToken = session?.access_token;
        if (!accessToken) {
          throw new Error(
            "Sign in to use Atlarix Core. (Core requests are authorized with your Atlarix account.)",
          );
        }
        // Plain OpenAI-compatible, matching the BYOK open-weight providers below.
        // Core forwards to DeepSeek/Qwen/Moonshot/MiniMax directly now, and the
        // OpenRouter SDK would serialize OpenRouter-only body fields (plugins,
        // its own `reasoning` object) that those vendors don't accept.
        //
        // The WIRE id stays `vendor/model`: the proxy's allowlist keys on it and
        // rewrites it to the vendor's native id, which is what lets already-
        // installed clients keep working through the cutover.
        const core = createOpenAICompatible({
          name: COMPASS_PROVIDER_ID,
          baseURL: proxyBaseUrl,
          apiKey: accessToken,
        });
        return {
          modelClient: {
            model: core(coreModelId),
            builtinProviderId: "compass",
          },
          backupModelClients: [],
        };
      }

      // Dev-only fallback: no proxy configured (local dev). Use a LOCAL dev key and
      // call OpenRouter directly — still the OpenRouter SDK, because without the
      // proxy there is nothing to rewrite the `vendor/model` id to a native one.
      // Never reachable in a packaged release (the embedded master key was removed
      // and the dev key provider is a no-op there), so production always goes
      // through the proxy above.
      const devKey = getCompassMasterApiKey();
      if (!devKey) {
        throw new Error(
          "Atlarix Core is not configured for this build (no proxy URL and no local dev key). Add your own API keys in Settings or use a release build.",
        );
      }
      const or = createOpenRouter({
        apiKey: devKey,
        headers: { ...OPENROUTER_APP_HEADERS },
      });
      return {
        modelClient: {
          model: or(coreModelId),
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
      // Local runtimes need no API key, so they never reach the provider-key
      // handler that fires `model_connected` — without this a local-only user
      // never enters the activation funnel at all. Fires once per install.
      trackLocalModelConnected(providerId);
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
      trackLocalModelConnected(providerId);
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
    case "huggingface": {
      const provider = createOpenAICompatible({
        name: "huggingface",
        baseURL: "https://router.huggingface.co/v1",
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
    // Open-weight providers — all OpenAI-compatible, baseURL from the shared map.
    case "deepseek":
    case "qwen":
    case "minimax":
    case "moonshot": {
      const provider = createOpenAICompatible({
        name: providerId,
        baseURL: OPENWEIGHT_PROVIDER_BASE_URLS[providerId],
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
      // Any provider carrying a base URL is treated as OpenAI-compatible and
      // instantiated from that URL + key: this covers user-defined custom (DB)
      // providers AND the full models.dev catalog (opencode parity — the long
      // tail of providers that share the OpenAI wire format, no per-provider SDK).
      if (providerConfig.apiBaseUrl) {
        const provider = createOpenAICompatible({
          name: providerConfig.id,
          baseURL: providerConfig.apiBaseUrl,
          apiKey,
        });
        return {
          modelClient: {
            model: provider(model.name),
            builtinProviderId: providerConfig.id,
          },
          backupModelClients: [],
        };
      }
      if (providerConfig.type === "custom") {
        throw new Error(
          `Custom provider ${model.provider} is missing the API Base URL.`,
        );
      }
      // Not a known ID, no base URL to fall back on → unsupported.
      throw new Error(`Unsupported model provider: ${model.provider}`);
    }
  }
}
