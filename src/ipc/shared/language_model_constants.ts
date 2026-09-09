import { OPENAI_COMPATIBLE_NPM } from "./provider-sdk-factories";

/** Providers that support extended thinking/reasoning modes */
export const PROVIDERS_THAT_SUPPORT_THINKING: string[] = [
  "google",
  "vertex",
  // Open-weight reasoners: DeepSeek (deepseek-reasoner), Qwen3 thinking,
  // MiniMax M2.x thinking modes.
  "deepseek",
  "qwen",
  "minimax",
];

/**
 * Base URLs for built-in OpenAI-compatible open-weight providers.
 *
 * These are PINS, not the general mechanism: every one of them differs from what
 * models.dev would give us, so adopting the catalog blindly would change the wire
 * format or the path. Kept in `PROVIDER_OVERLAY.apiBaseUrl` too — this export
 * remains because the model fetchers read it directly.
 *
 *  - `deepseek`: catalog says `https://api.deepseek.com` (no `/v1`).
 *  - `minimax`:  catalog says `https://api.minimax.io/anthropic/v1` with
 *                `npm: @ai-sdk/anthropic` — a DIFFERENT wire format. MiniMax-M3 is
 *                the benchmarked model; switching it is a deliberate decision, not a
 *                side effect of un-hardcoding providers.
 *  - `qwen`/`moonshot`: match the catalog today; pinned so a catalog edit can't
 *                silently move a first-class provider.
 */
export const OPENWEIGHT_PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  // Alibaba DashScope OpenAI-compatible mode (international endpoint).
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  minimax: "https://api.minimax.io/v1",
  // Moonshot AI / Kimi.
  moonshot: "https://api.moonshot.ai/v1",
};

/**
 * Model lists are now fetched dynamically from models.dev (OpenCode-style).
 * See lib/models_dev.ts and language_model_helpers.ts
 */

/**
 * PREFERRED env var per provider — the FIRST name to try, not the only one.
 *
 * models.dev publishes `env` as an ordered ARRAY and the catalog path used to take
 * `env[0]`, which is wrong for Google: its array is
 * `["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"]` while the
 * AI SDK reads the second. `resolveProviderEnvVarNames` puts this value first and
 * then appends the catalog's list, so every documented name still works.
 */
export const PROVIDER_TO_ENV_VAR: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
  togetherai: "TOGETHER_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  bedrock: "AWS_BEARER_TOKEN_BEDROCK",
  elastic: "ELASTIC_AGENT_BUILDER_API_KEY",
  nvidia_nim: "NVIDIA_NIM_API_KEY",
  cohere: "COHERE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  huggingface: "HF_TOKEN",
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  minimax: "MINIMAX_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
};

/**
 * PRESENTATION + PIN OVERLAY for the providers we treat as first-class.
 *
 * This used to be the provider REGISTRY: if a provider wasn't listed here it didn't
 * exist, so every addition needed an app release. The registry is now models.dev
 * (172 providers, hourly-refreshed) and this table only carries what the catalog
 * cannot tell us or must not decide:
 *
 *  - `displayName` / `websiteUrl` / `hasFreeTier` — hand-curated. models.dev has a
 *    `doc` field, but that's a documentation page; `websiteUrl` points at the
 *    key-creation console, which is what a user actually needs. Neither is derivable.
 *  - `gatewayPrefix` / `secondary` — Atlarix-specific routing and ordering.
 *  - `apiBaseUrl` / `npm` — PINS. Present only where the catalog is absent (Groq,
 *    Mistral, Perplexity, Cerebras, Together ship dedicated SDKs, so models.dev omits
 *    `api`) or where it disagrees with shipped behaviour (see
 *    `OPENWEIGHT_PROVIDER_BASE_URLS`). A pin means "we decided this deliberately",
 *    not "we forgot to delete it".
 *
 * A provider absent from this table is still fully usable — it just gets its name and
 * endpoint from the catalog and no curated key link.
 */
export const CLOUD_PROVIDERS: Record<
  string,
  {
    displayName: string;
    hasFreeTier?: boolean;
    websiteUrl?: string;
    // Optional: providers WITHOUT a gateway prefix (e.g. Hugging Face) are not
    // proxied by the Atlarix Pro engine, so they always use direct BYOK.
    gatewayPrefix?: string;
    secondary?: boolean;
    /** Pin: overrides models.dev's `api` (or supplies one when it has none). */
    apiBaseUrl?: string;
    /** Pin: overrides models.dev's `npm`, i.e. which SDK/wire format to use. */
    npm?: string;
  }
> = {
  compass: {
    displayName: "Atlarix Core",
    hasFreeTier: false,
    gatewayPrefix: "",
  },
  openrouter: {
    displayName: "OpenRouter (BYOK)",
    hasFreeTier: true,
    websiteUrl: "https://openrouter.ai/keys",
    gatewayPrefix: "",
  },
  huggingface: {
    displayName: "Hugging Face",
    hasFreeTier: false,
    websiteUrl: "https://huggingface.co/settings/tokens",
    // No gatewayPrefix on purpose — HF is direct-BYOK only (not via the Pro engine).
    apiBaseUrl: "https://router.huggingface.co/v1",
  },
  openai: {
    displayName: "OpenAI",
    hasFreeTier: false,
    websiteUrl: "https://platform.openai.com/api-keys",
    gatewayPrefix: "",
  },
  google: {
    displayName: "Google Gemini",
    hasFreeTier: true,
    websiteUrl: "https://aistudio.google.com/apikey",
    gatewayPrefix: "",
  },
  anthropic: {
    displayName: "Anthropic (Claude)",
    hasFreeTier: false,
    websiteUrl: "https://console.anthropic.com/settings/keys",
    gatewayPrefix: "",
  },
  xai: {
    displayName: "Grok (xAI)",
    hasFreeTier: false,
    websiteUrl: "https://console.x.ai/",
    gatewayPrefix: "",
  },
  togetherai: {
    displayName: "Together AI",
    hasFreeTier: true,
    websiteUrl: "https://api.together.xyz/settings/api-keys",
    gatewayPrefix: "",
    apiBaseUrl: "https://api.together.xyz/v1",
  },
  groq: {
    displayName: "Groq",
    hasFreeTier: true,
    websiteUrl: "https://console.groq.com/keys",
    gatewayPrefix: "",
    apiBaseUrl: "https://api.groq.com/openai/v1",
  },
  mistral: {
    displayName: "Mistral AI",
    hasFreeTier: false,
    websiteUrl: "https://console.mistral.ai/api-keys/",
    gatewayPrefix: "",
    apiBaseUrl: "https://api.mistral.ai/v1",
  },
  bedrock: {
    displayName: "AWS Bedrock",
    hasFreeTier: false,
    websiteUrl: "https://console.aws.amazon.com/bedrock/",
    gatewayPrefix: "",
  },
  elastic: {
    displayName: "Elastic Agent Builder",
    hasFreeTier: false,
    websiteUrl:
      "https://www.elastic.co/docs/explore-analyze/ai-features/elastic-agent-builder",
    gatewayPrefix: "",
  },
  nvidia_nim: {
    displayName: "NVIDIA NIM",
    hasFreeTier: false,
    websiteUrl: "https://build.nvidia.com/",
    gatewayPrefix: "",
    apiBaseUrl: "https://integrate.api.nvidia.com/v1",
  },
  cohere: {
    displayName: "Cohere",
    hasFreeTier: false,
    websiteUrl: "https://dashboard.cohere.com/api-keys",
    gatewayPrefix: "",
  },
  perplexity: {
    displayName: "Perplexity",
    hasFreeTier: false,
    websiteUrl: "https://www.perplexity.ai/api-platform",
    gatewayPrefix: "",
    apiBaseUrl: "https://api.perplexity.ai",
  },
  cerebras: {
    displayName: "Cerebras",
    hasFreeTier: false,
    websiteUrl: "https://inference-docs.cerebras.ai/",
    gatewayPrefix: "",
    apiBaseUrl: "https://api.cerebras.ai/v1",
  },
  deepseek: {
    displayName: "DeepSeek",
    hasFreeTier: false,
    websiteUrl: "https://platform.deepseek.com/api_keys",
    gatewayPrefix: "",
  },
  qwen: {
    displayName: "Qwen (Alibaba)",
    hasFreeTier: false,
    websiteUrl: "https://bailian.console.alibabacloud.com/?apiKey=1",
    gatewayPrefix: "",
  },
  minimax: {
    displayName: "MiniMax",
    hasFreeTier: false,
    websiteUrl:
      "https://platform.minimax.io/user-center/basic-information/interface-key",
    gatewayPrefix: "",
    // Pin the WIRE FORMAT, not just the URL. models.dev moved MiniMax to
    // `@ai-sdk/anthropic` at `/anthropic/v1`; MiniMax-M3 is the model the published
    // benchmark ran on, so that switch has to be measured, not inherited.
    npm: OPENAI_COMPATIBLE_NPM,
  },
  moonshot: {
    displayName: "Kimi (Moonshot)",
    hasFreeTier: false,
    websiteUrl: "https://platform.moonshot.ai/console/api-keys",
    gatewayPrefix: "",
  },
};

/**
 * The base URL to dispatch a provider on: overlay pin → open-weight map → catalog.
 *
 * A pin wins so a catalog edit can never silently re-point a first-class provider;
 * the catalog fills in everyone else, which is what makes the long tail work without
 * an app release.
 */
export function resolveProviderBaseUrl(
  providerId: string,
  catalogApi?: string,
): string | undefined {
  return (
    CLOUD_PROVIDERS[providerId]?.apiBaseUrl ??
    OPENWEIGHT_PROVIDER_BASE_URLS[providerId] ??
    catalogApi
  );
}

/** The SDK/wire format to dispatch a provider on: overlay pin → catalog `npm`. */
export function resolveProviderNpm(
  providerId: string,
  catalogNpm?: string,
): string | undefined {
  return CLOUD_PROVIDERS[providerId]?.npm ?? catalogNpm;
}

/**
 * Every env var name to try for a provider, best first.
 *
 * A LIST rather than one name: models.dev publishes several per provider and users
 * have whichever their other tooling set. The curated `PROVIDER_TO_ENV_VAR` value
 * goes first (it is the one the SDK itself reads — see the note there), then the
 * catalog's order, de-duplicated.
 */
export function resolveProviderEnvVarNames(
  providerId: string,
  catalogEnvVars?: readonly string[],
): string[] {
  const preferred = PROVIDER_TO_ENV_VAR[providerId];
  return [
    ...new Set([preferred, ...(catalogEnvVars ?? [])].filter(Boolean)),
  ] as string[];
}

export const LOCAL_PROVIDERS: Record<
  string,
  {
    displayName: string;
    hasFreeTier: boolean;
  }
> = {
  ollama: {
    displayName: "Ollama",
    hasFreeTier: true,
  },
  lmstudio: {
    displayName: "LM Studio",
    hasFreeTier: true,
  },
};
