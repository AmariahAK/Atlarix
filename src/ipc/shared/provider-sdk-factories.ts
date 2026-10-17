/**
 * Provider → AI-SDK factory, keyed on models.dev's `npm` field.
 *
 * WHY THIS EXISTS
 * ---------------
 * `get_model_client.ts` carried a ~20-case switch in which 11 cases were the same
 * three lines — `createOpenAICompatible({ name, baseURL, apiKey })` — differing only
 * by a hardcoded URL. Meanwhile models.dev ships 172 providers and already tells us
 * which SDK each one speaks, in its `npm` field. Dispatching on that field turns
 * "20 providers we hardcoded" into "every provider in the catalog", and adding one
 * stops requiring an app release.
 *
 * THE RULE (derived from the catalog, not guessed)
 * -----------------------------------------------
 *  - `npm` maps to an INSTALLED factory and the provider has NO `api` URL → it is the
 *    vendor's own first-party endpoint; construct the SDK with no baseURL
 *    (`openai`, `anthropic`, `google`, `azure` … the SDK bakes its host in, which is
 *    exactly WHY models.dev omits `api` for those 24 providers).
 *  - `npm` maps to an INSTALLED factory and the provider HAS an `api` URL → same wire
 *    format at a different host; construct the SDK pointed at that URL. This is how
 *    8 of the 9 `@ai-sdk/anthropic` providers work (MiniMax, Kimi-for-coding, …) and
 *    3 of the 4 `@ai-sdk/openai` ones.
 *  - `npm` maps to NOTHING installed → treat it as OpenAI-compatible and use the
 *    `api` URL. This covers the 136-provider long tail plus Groq/Mistral/Perplexity/
 *    Cerebras/Together, whose dedicated SDKs we deliberately don't ship (their URL
 *    comes from the overlay, since models.dev omits `api` for them too).
 *
 * Providers needing more than (baseURL, apiKey) — Vertex (service account), Azure
 * (resourceName), Bedrock (region), Cohere/Elastic (non-OpenAI adapters), OpenRouter
 * (routing + plugins), Core, and the local runtimes — stay explicit in
 * `get_model_client.ts`. This module is for the ones that genuinely are just a URL
 * and a key.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI as createGoogle } from "@ai-sdk/google";
import { createXai } from "@ai-sdk/xai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * A constructed model object, whatever provider-SPEC version it implements.
 *
 * This used to be spelled `LanguageModelV2 | LanguageModelV3`, which meant every SDK
 * major turned into a compile error in seven files for no behavioural reason — the
 * v6→v7 bump alone produced 22 of them, all saying `"v4" is not assignable to "v3"`.
 * `ai`'s own `LanguageModel` already unions every spec version it accepts, so deferring
 * to it means the next spec bump costs nothing here.
 *
 * `Exclude<…, string>` drops the bare model-id form: these factories return a
 * constructed model, never an id for the SDK's global registry to resolve.
 */
export type AtlarixLanguageModel = Exclude<LanguageModel, string>;

/** The generic wire format — also the fallback for any unmapped `npm`. */
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

export interface ProviderFactoryInput {
  /** Atlarix provider id — used as the SDK instance name (appears in errors). */
  providerId: string;
  modelId: string;
  apiKey?: string;
  /**
   * Resolved base URL: the overlay's pin, else models.dev's `api`. Absent for a
   * vendor-native endpoint (see the rule above).
   */
  baseURL?: string;
  /**
   * How the Anthropic format takes the key: `x-api-key` (Anthropic's own) or a
   * Bearer token (Bedrock's /anthropic endpoint, many gateways). Only a provider
   * the user added sets it; the other factories ignore it.
   */
  authHeader?: "x-api-key" | "bearer";
}

export type ProviderSdkFactory = (
  input: ProviderFactoryInput,
) => AtlarixLanguageModel;

/**
 * Factories for the SDKs this app actually bundles. Keyed by the exact `npm` string
 * models.dev publishes, so the catalog is the lookup key and nothing has to be
 * restated per provider.
 *
 * Deliberately NOT here: `@ai-sdk/azure`, `@ai-sdk/google-vertex`,
 * `@ai-sdk/amazon-bedrock` — all installed, but none is constructible from
 * (baseURL, apiKey) alone, so they stay in `get_model_client.ts` where their extra
 * settings live.
 */
export const PROVIDER_SDK_FACTORIES: Record<string, ProviderSdkFactory> = {
  [OPENAI_COMPATIBLE_NPM]: ({ providerId, modelId, apiKey, baseURL }) => {
    if (!baseURL) {
      throw new Error(
        `Provider "${providerId}" is OpenAI-compatible but has no API base URL. ` +
          `Add one in Settings, or pin it in the provider overlay.`,
      );
    }
    return createOpenAICompatible({ name: providerId, baseURL, apiKey })(
      modelId,
    );
  },

  "@ai-sdk/openai": ({ modelId, apiKey, baseURL }) => {
    const provider = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    // The Responses API is OpenAI's own surface. A third party serving the OpenAI
    // wire format at its own host (vivgrid, meta, perplexity-agent) implements
    // /chat/completions, NOT /responses — so only the first-party endpoint, which is
    // the one with no baseURL, gets `.responses()`.
    return baseURL ? provider(modelId) : provider.responses(modelId);
  },

  // Exactly one of apiKey / authToken: the SDK refuses both.
  "@ai-sdk/anthropic": ({ modelId, apiKey, baseURL, authHeader }) =>
    createAnthropic({
      ...(authHeader === "bearer" ? { authToken: apiKey } : { apiKey }),
      ...(baseURL ? { baseURL } : {}),
    })(modelId),

  "@ai-sdk/google": ({ modelId, apiKey, baseURL }) =>
    createGoogle({ apiKey, ...(baseURL ? { baseURL } : {}) })(modelId),

  "@ai-sdk/xai": ({ modelId, apiKey, baseURL }) =>
    createXai({ apiKey, ...(baseURL ? { baseURL } : {}) })(modelId),
};

/** Whether a models.dev `npm` value has a bundled factory. */
export function hasProviderSdkFactory(npm: string | undefined): boolean {
  return Boolean(npm && npm in PROVIDER_SDK_FACTORIES);
}

/**
 * Resolve the factory for a provider.
 *
 * An unmapped `npm` falls back to OpenAI-compatible rather than failing: that is the
 * whole point of the long tail, and a provider we've never heard of that speaks the
 * OpenAI format works today. The fallback still needs a `baseURL`, and says so
 * clearly when one is missing.
 */
export function resolveProviderSdkFactory(
  npm: string | undefined,
): ProviderSdkFactory {
  return (
    (npm ? PROVIDER_SDK_FACTORIES[npm] : undefined) ??
    PROVIDER_SDK_FACTORIES[OPENAI_COMPATIBLE_NPM]!
  );
}

/**
 * Build a model client for any provider that is "just a URL and a key".
 * Throws with an actionable message when it isn't — never returns a broken client.
 */
export function createModelFromCatalog(
  input: ProviderFactoryInput & { npm?: string },
): AtlarixLanguageModel {
  return resolveProviderSdkFactory(input.npm)(input);
}
