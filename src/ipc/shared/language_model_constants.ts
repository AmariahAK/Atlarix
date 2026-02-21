import { LanguageModel } from "../ipc_types";

/** Providers that support extended thinking/reasoning modes */
export const PROVIDERS_THAT_SUPPORT_THINKING: string[] = [
  "google",
  "vertex",
  "auto",
];

/**
 * Model lists are now fetched dynamically from models.dev (OpenCode-style).
 * See lib/models_dev.ts and language_model_helpers.ts
 */

export const TURBO_MODELS: LanguageModel[] = [
  {
    apiName: "glm-4.6:turbo",
    displayName: "GLM 4.6",
    description: "Strong coding model (very fast)",
    maxOutputTokens: 32_000,
    contextWindow: 131_000,
    temperature: 0,
    dollarSigns: 3,
    type: "cloud",
  },
  {
    apiName: "kimi-k2:turbo",
    displayName: "Kimi K2",
    description: "Kimi 0905 update (fast)",
    maxOutputTokens: 16_000,
    contextWindow: 256_000,
    temperature: 0,
    dollarSigns: 2,
    type: "cloud",
  },
];

// No longer needed since models are fetched dynamically
export const FREE_OPENROUTER_MODEL_NAMES: string[] = [];

export const PROVIDER_TO_ENV_VAR: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
  togetherai: "TOGETHER_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  bedrock: "AWS_BEARER_TOKEN_BEDROCK",
  elastic: "ELASTIC_AGENT_BUILDER_API_KEY",
};

export const CLOUD_PROVIDERS: Record<
  string,
  {
    displayName: string;
    hasFreeTier?: boolean;
    websiteUrl?: string;
    gatewayPrefix: string;
    secondary?: boolean;
  }
> = {
  openrouter: {
    displayName: "OpenRouter",
    hasFreeTier: true,
    websiteUrl: "https://openrouter.ai/settings/keys",
    gatewayPrefix: "openrouter/",
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
  },
  groq: {
    displayName: "Groq",
    hasFreeTier: true,
    websiteUrl: "https://console.groq.com/keys",
    gatewayPrefix: "",
  },
  mistral: {
    displayName: "Mistral AI",
    hasFreeTier: false,
    websiteUrl: "https://console.mistral.ai/api-keys/",
    gatewayPrefix: "",
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
    websiteUrl: "https://www.elastic.co/docs/explore-analyze/ai-features/elastic-agent-builder",
    gatewayPrefix: "",
  },
};

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
