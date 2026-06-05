/**
 * Workstation identity block: model names itself; Atlarix is the host environment.
 */

import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import {
  resolveAtlarixCoreIdentity,
  type AtlarixCoreTierPresentation,
} from "@/lib/atlarix-core-catalog";
import { formatModelApiNameForDisplay } from "@/lib/format-openrouter-model-label";
import { isCompassTierId } from "@/shared/compass_product_copy";

const PROVIDER_BRANDS: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  groq: "Groq",
  togetherai: "Together AI",
  mistral: "Mistral",
  xai: "xAI",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  azure: "Azure",
  vertex: "Google Vertex",
  bedrock: "Amazon Bedrock",
  auto: "Auto",
};

export function providerBrandName(providerId: string): string {
  const key = providerId.trim().toLowerCase();
  if (PROVIDER_BRANDS[key]) return PROVIDER_BRANDS[key];
  if (!key) return "your provider";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export { formatModelApiNameForDisplay };

export type ActiveModelIdentity = {
  modelDisplayName: string;
  providerBrand: string;
  /** Full line for prompts/UI: `deepseek v4 pro (openrouter)` */
  labelWithProvider?: string;
};

export function resolveActiveModelIdentity(
  model: LargeLanguageModel,
  settings?: UserSettings | null,
  catalog?: AtlarixCoreTierPresentation[],
): ActiveModelIdentity {
  if (model.provider === "auto") {
    return {
      modelDisplayName: "Unconfigured model",
      providerBrand: "auto",
      labelWithProvider: "Select a model in chat settings",
    };
  }
  if (model.provider === "compass" || isCompassTierId(model.name)) {
    const core = resolveAtlarixCoreIdentity(model.name, catalog);
    return {
      modelDisplayName: core.modelDisplayName,
      providerBrand: core.providerSlug,
      labelWithProvider: core.labelWithProvider,
    };
  }
  const modelDisplayName = formatModelApiNameForDisplay(model.name);
  const providerBrand = providerBrandName(model.provider).toLowerCase();
  return {
    modelDisplayName,
    providerBrand,
    labelWithProvider: `${modelDisplayName} (${providerBrand})`,
  };
}

export function buildWorkstationIdentityBlock(args: {
  modelDisplayName: string;
  providerBrand: string;
  appVersion: string;
  labelWithProvider?: string;
}): string {
  const { modelDisplayName, providerBrand, appVersion } = args;
  const selfLabel =
    args.labelWithProvider ??
    `${modelDisplayName} (${providerBrand.toLowerCase()})`;
  return `# Runtime identity
You are **${modelDisplayName}**, running inside **Atlarix** — an agent workstation for software development.
**Atlarix** ([atlarix.dev](https://atlarix.dev)) is built by **NorahLabs** ([norahlabs.com](https://norahlabs.com/)). Atlarix provides your tools, workspace context, and session memory.
Refer to yourself as **${selfLabel}**.
Do not call yourself "Atlarix AI" or claim to be a product of Atlarix — Atlarix is the workstation you run inside, not your maker or your name. Never reference internal model-routing tier names; you are simply the model named above.
**App shell version:** \`${appVersion}\`
If asked who built Atlarix, say **NorahLabs** ([norahlabs.com](https://norahlabs.com/)). If asked what you are, identify as **${selfLabel}** running inside Atlarix — not as Atlarix itself.`;
}
