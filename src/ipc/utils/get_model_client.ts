import { throughFreeAutoGate } from "@/lib/billing/free-auto-gate";
import { coreSessionId } from "@/lib/core/session-header";
import { noteLadderTop } from "@/lib/core/zenith-offer";
import { createOpenAI } from "@ai-sdk/openai";
import {
  getPinnedProviderKey,
  isOwnKeyRun,
} from "@/ipc/shared/pinned-provider-key";
import { createGoogleGenerativeAI as createGoogle } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { createVertex as createGoogleVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import type { AtlarixLanguageModel } from "@/ipc/shared/provider-sdk-factories";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { OPENROUTER_APP_HEADERS } from "../shared/openrouter_app_headers";
import {
  COMPASS_PROVIDER_ID,
} from "../shared/compass_constants";
import {
  createModelFromCatalog,
  hasProviderSdkFactory,
} from "../shared/provider-sdk-factories";
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

import { getEnvVar } from "./read_env";
import log from "electron-log";
import { hasStoredProviderKey } from "@/main/settings";
import { getLanguageModelProviders } from "../shared/language_model_helpers";
import { getProviderApiKey } from "../shared/provider_api_keys";
import { LanguageModelProvider } from "../ipc_types";
import {
  autoConsentHeader,
  getCompassMasterApiKey,
  getCoreModelIdForCoreTier,
  isCoreTierFromNewerBuild,
  isCoreAutoTier,
  isCoreZenithTier,
  resolveConfiguredCoreTier,
} from "../shared/compass_constants";
import {
  surfaceHeaders,
  coreProxyFetch,
  getCoreProxyBaseUrl,
  getPinnedCoreToken,
} from "../shared/core_proxy";
import { autoStatusFromHeaders, broadcastAutoStatus } from "@/main/auto-status";
import { noteTurnAutoBilling } from "@/lib/analytics/turn-stats";
import { getSession } from "../../lib/auth/supabase-client";
import { LM_STUDIO_BASE_URL } from "./lm_studio_utils";
import { createOllamaProvider } from "./ollama_provider";
import { trackLocalModelConnected } from "@/main/lib/analytics";
import { getOllamaApiUrl } from "../handlers/local_model_ollama_handler";
import { autoEffort } from "@/lib/routing/model-reasoning-profile";
import { CORE_TIER_NEWER_BUILD } from "@/shared/texts";

export interface ModelClient {
  // ai@6: v3-spec providers are the norm; the two custom V2 adapters
  // (elastic/cohere) run via the SDK's compat wrapper, so both spec
  // versions are valid here.
  model: AtlarixLanguageModel;
  builtinProviderId?: string;
}

export interface GetModelClientOptions {
  /** @deprecated Ignored — unified runtime uses role/depth only. */
  agentMode?: "direct" | "guided" | "autonomous";
  delegationRole?: "main" | "agent" | "subagent";
  delegationDepth?: number;
  complexityBump?: boolean;
  /**
   * What this call is for, sent to Atlarix Core as `X-Atlarix-Purpose` so paid
   * Auto can pick a model per request. Hints only: the proxy bills the model
   * that answered. Ignored off Core.
   */
  purpose?:
    | "main"
    | "subagent"
    | "title"
    | "memory"
    | "compaction"
    | "summary"
    | "transcribe";
  /** The turn's work mode (`X-Atlarix-Mode`): build | debug | ask | plan. */
  workMode?: string;
  /** "Try with a stronger model": one level up for this turn (`X-Atlarix-Escalate`). */
  escalate?: boolean;
  /** The chat whose turn this is: an Auto reply's free/paid is noted against it (turn_completed). */
  chatId?: number;
  /**
   * The chat a side call belongs to (title, compaction, sub-agent), for
   * `X-Atlarix-Session` only, without the turn bookkeeping `chatId` drives.
   */
  sessionChatId?: number;
  /** A turn the user asked for again: its first Core request says so (`X-Atlarix-Retry`). */
  userRetry?: boolean;
}

const logger = log.scope("getModelClient");

/**
 * The hints Atlarix Auto routes on. Paid Auto picks a model from them; free
 * Auto needs the consent header (the free path shares prompts with the
 * providers that serve it). Its value is the wording version the user accepted:
 * the proxy offers the free gateways only on "2".
 */
export function autoRequestHeaders(
  settings: Pick<UserSettings, "deepThinking" | "effort" | "atlarixAutoConsentAt" | "atlarixAutoConsentVersion">,
  options?: GetModelClientOptions,
): Record<string, string> {
  // /effort on Auto: low | medium | max choose the lanes. The thinking header
  // stays for a proxy that predates the effort header (max = deep thinking).
  const effort = autoEffort(settings);
  const out: Record<string, string> = {
    "X-Atlarix-Purpose":
      options?.purpose ??
      (options?.delegationRole === "subagent" ? "subagent" : "main"),
    "X-Atlarix-Effort": effort,
    "X-Atlarix-Thinking": effort === "max" ? "1" : "0",
  };
  if (options?.workMode) out["X-Atlarix-Mode"] = options.workMode;
  if (options?.escalate) out["X-Atlarix-Escalate"] = "1";
  // "1" whenever the user said yes, so a proxy that predates the v2 wording
  // still serves them (OpenAI only); the version rides in its own header.
  const consent = autoConsentHeader(settings);
  if (consent) {
    out["X-Atlarix-Free-Consent"] = "1";
    out["X-Atlarix-Free-Consent-Version"] = consent;
  }
  return out;
}

/** True if a provider has a usable API key (settings → DB → env). */
/** http(s)://localhost, 127.x.x.x or [::1], any port. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

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
  // A key passed with --api-key-file (in memory only). Missing here, the gate below
  // called the run keyless and fell back to Core though getRegularModelClient
  // would have used it (found by running a headless run on a key file for real).
  if (getPinnedProviderKey(provider)) return true;
  // A model on the user's own machine (Ollama, LM Studio, or a custom provider
  // at a loopback address) needs no key: there is nobody to authenticate to.
  // Treated as keyless, `atlarix --provider-url http://localhost:11434/v1`
  // fell back to Atlarix Core and failed "Sign in to use Atlarix Core".
  if (
    providerConfig.type === "local" ||
    isLoopbackUrl(providerConfig.apiBaseUrl)
  )
    return true;
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
  options?: GetModelClientOptions,
): Promise<{
  modelClient: ModelClient;
  backupModelClients: ModelClient[];
}> {
  const allProviders = await getLanguageModelProviders();

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

  // A provider with no usable key fails here, saying so. It used to fall back
  // to Atlarix Core, silently and paid, including when the key was there but
  // couldn't be read (a busy or changed keychain: 15.11.1 QA E9). A turn never
  // moves to Core unless Core was chosen.
  if (model.provider !== COMPASS_PROVIDER_ID && !(await hasUsableProviderKey(model.provider, settings, providerConfig))) {
    const name = providerConfig.name || model.provider;
    if (hasStoredProviderKey(model.provider)) {
      throw new Error(`Can't read the saved key for ${name}; re-enter it with /connect (Settings in the app).`);
    }
    // An own-key run (a headless run's key file) was given the key it uses.
    if (isOwnKeyRun()) {
      throw new Error(
        `This run uses your own API key, but there is none for ${model.provider}. Check the provider and model set for the run (ATLARIX_PROVIDER / ATLARIX_MODEL).`,
      );
    }
    // Your own endpoint may take no key (the address decides); Vertex and
    // Bedrock sign in with the machine's cloud credentials when there is none.
    // Those are asked as they are, and say so themselves if they need more.
    if (providerConfig.type !== "custom" && model.provider !== "vertex" && model.provider !== "bedrock") {
      throw new Error(`No key for ${name}. Add one with /connect (Settings in the app), or pick another model.`);
    }
  }

  return getRegularModelClient(model, settings, providerConfig, options);
}

async function getRegularModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  providerConfig: LanguageModelProvider,
  options?: GetModelClientOptions,
): Promise<{
  modelClient: ModelClient;
  backupModelClients: ModelClient[];
}> {
  // Get API key for the specific provider
  // Priority: pinned (--api-key-file, in memory only) -> settings ->
  // database -> env (so UI/database key wins over .env)
  let apiKey =
    getPinnedProviderKey(model.provider) ??
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
      if (!resolvedTier && isCoreAutoTier(model.name)) {
        throw new Error(
          "Atlarix Auto isn't offered right now. Pick a Core model above, or add your own API key in Settings.",
        );
      }
      if (!resolvedTier && isCoreZenithTier(model.name)) {
        throw new Error(
          "Atlarix Zenith isn't offered right now. Pick another model above, or add your own API key in Settings.",
        );
      }
      if (!resolvedTier && isCoreTierFromNewerBuild(model.name)) {
        throw new Error(CORE_TIER_NEWER_BUILD);
      }
      if (!resolvedTier) {
        throw new Error(
          `No Atlarix Core model is configured for this build. Add your own API keys in Settings, or use a release build.`,
        );
      }
      // No consent gate here any more: Auto is paid for anyone with credit, and
      // only the FREE path shares prompts. The consent header below lets the
      // proxy serve free; without it a no-credit caller gets a 402 that the
      // classifier turns into the consent notice.
      if (resolvedTier.substituted) {
        logger.info(
          `Core tier "${model.name}" is not in the current lineup — using ${resolvedTier.tier}.`,
        );
        model = { ...model, name: resolvedTier.tier };
      }
      const coreModelId = getCoreModelIdForCoreTier(resolvedTier.tier);
      const isAutoTier = isCoreAutoTier(resolvedTier.tier);
      // Zenith is paid Auto on the top lane: Auto's routing headers, never the
      // free-share consent, and no daily limit to hold.
      const isZenithTier = isCoreZenithTier(resolvedTier.tier);
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
        // A headless cloud run carries its own job-scoped token and has no
        // session at all; everything else authenticates as the signed-in user.
        const pinnedToken = getPinnedCoreToken();
        const accessToken = pinnedToken ?? (await getSession())?.access_token;
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
        //
        // `apiKey` alone would FREEZE this token into the client for its whole
        // lifetime. Supabase access tokens last ~1 hour, while a turn can run far
        // longer — an agentic loop, or one parked on a background job — so a
        // long turn eventually sends an expired token and the proxy 401s. The
        // custom fetch re-reads the session per request instead; `getSession()`
        // refreshes when needed (autoRefreshToken is on), so this is the ONE
        // place that has to be right for every Core call. The static apiKey is
        // kept as the construction-time default and as the fallback if a session
        // read fails mid-turn — never worse than today's behaviour.
        const autoHeaders = autoRequestHeaders(settings, options);
        // One id per chat on every Core request of it (session-header.ts).
        const sessionId = coreSessionId(options?.sessionChatId ?? options?.chatId);
        // Only the FIRST request of a user's retry says so: the steps after it,
        // and any automatic network retry, are ordinary requests.
        let retryPending = options?.userRetry === true;
        const core = createOpenAICompatible({
          name: COMPASS_PROVIDER_ID,
          baseURL: proxyBaseUrl,
          apiKey: accessToken,
          fetch: async (input, init) => {
            let bearer = accessToken;
            try {
              const fresh = pinnedToken ?? (await getSession())?.access_token;
              if (fresh) bearer = fresh;
            } catch {
              /* keep the construction-time token — a refused request is better
                 than a request we never send */
            }
            const headers = new Headers(
              init?.headers as HeadersInit | undefined,
            );
            headers.set("Authorization", `Bearer ${bearer}`);
            // Which Atlarix surface is spending. A LABEL on the ledger row, in
            // the same sense as the reviewer's `x-atlarix-repo`: the proxy
            // validates it against an allowlist and it never selects an
            // account — who pays comes from the verified JWT above.
            //
            // It has to be sent from the FIRST Core call a surface ever makes.
            // A ledger row cannot be re-attributed later, so spend recorded
            // without one is indistinguishable from desktop spend forever.
            // 'app' is this surface's value and stays that way: renaming it to
            // 'desktop' would split one product across two rows on the account
            // page and need every historical row backfilled.
            for (const [k, v] of Object.entries(surfaceHeaders())) headers.set(k, v);
            if (sessionId) headers.set("X-Atlarix-Session", sessionId);
            if (retryPending) {
              headers.set("X-Atlarix-Retry", "1");
              retryPending = false;
            }
            if (isAutoTier || isZenithTier) {
              for (const [k, v] of Object.entries(autoHeaders)) {
                if (isZenithTier && /free-consent/i.test(k)) continue;
                headers.set(k, v);
              }
            }
            // The proxy, or its fallback when the proxy is down (item 10). Free
            // Auto's daily limit is held here until it lifts, so a resend gets
            // the countdown without a request (free-auto-gate.ts).
            const send = () => coreProxyFetch(input as string, { ...init, headers });
            const res = isAutoTier && !pinnedToken ? await throughFreeAutoGate(send) : await send();
            // Atlarix Auto says which model answered and how much free share is
            // left; hand that to the composer.
            // Auto's top rung failed too: the turn's error offers Zenith once.
            if (isAutoTier) noteLadderTop(options?.chatId, res.headers);
            if ((isAutoTier || isZenithTier) && res.ok) {
              broadcastAutoStatus(res.headers);
              noteTurnAutoBilling(options?.chatId, autoStatusFromHeaders(res.headers)?.billing);
            }
            return res;
          },
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
      const bedrockSettings = settings.providerSettings?.bedrock as
        | { region?: string }
        | undefined;
      const region =
        bedrockSettings?.region || getEnvVar("AWS_REGION") || "us-east-1";
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
    case "cohere": {
      if (!apiKey) {
        throw new Error(
          "Cohere API key is required. Provide it in Settings or set COHERE_API_KEY.",
        );
      }
      const modelClient = createCohereChatModel({
        apiKey,
        modelId: model.name,
      });
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
          "Elastic Agent Builder requires Kibana URL. Set it in Settings > AI > Provider Settings (Elastic Agent Builder).",
        );
      }
      const elasticApiKey = apiKey || elasticSettings?.apiKey?.value;
      if (!elasticApiKey) {
        throw new Error(
          "Elastic Agent Builder requires an API key. Set it in Settings or set ELASTIC_AGENT_BUILDER_API_KEY.",
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
      // EVERY remaining provider — the models.dev catalog (172 and counting), the
      // former boilerplate cases (Groq, Mistral, Together, Perplexity, Cerebras,
      // Hugging Face, NVIDIA, DeepSeek, Qwen, MiniMax, Moonshot), and user-defined
      // custom DB providers — resolves through ONE path: pick the SDK from the
      // provider's `npm` (models.dev's own field, or an overlay pin) and point it at
      // the resolved base URL. Adding a provider no longer needs a case here, or a
      // release.
      //
      // The cases ABOVE are only the providers that need more than a URL and a key:
      // Core (JWT refresh), Vertex (service account), Azure (resourceName), Bedrock
      // (region), Cohere/Elastic (non-OpenAI adapters), OpenRouter (routing +
      // plugins), and the local runtimes.
      // A custom provider that is really Ollama (http://localhost:11434/v1) runs
      // through Ollama's native API, at the model's window, not 4096 (QA).
      if (
        providerConfig.type === "custom" &&
        providerConfig.apiBaseUrl &&
        providerConfig.apiFormat !== "anthropic"
      ) {
        const { isOllamaEndpoint, ollamaOrigin } = await import("./ollama_native_fetch");
        if (await isOllamaEndpoint(providerConfig.apiBaseUrl)) {
          return {
            modelClient: {
              model: createOllamaProvider({ baseURL: ollamaOrigin(providerConfig.apiBaseUrl) })(model.name),
              builtinProviderId: providerConfig.id,
            },
            backupModelClients: [],
          };
        }
      }
      if (
        providerConfig.apiBaseUrl ||
        hasProviderSdkFactory(providerConfig.npm)
      ) {
        return {
          modelClient: {
            model: createModelFromCatalog({
              providerId: providerConfig.id,
              modelId: model.name,
              apiKey,
              baseURL: providerConfig.apiBaseUrl,
              npm: providerConfig.npm,
              authHeader: providerConfig.authHeader,
            }),
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
      // Nothing tells us where to send the request or which SDK speaks its format.
      throw new Error(
        `Provider "${model.provider}" has no API base URL and no known SDK — ` +
          `add a Base URL for it in Settings.`,
      );
    }
  }
}
