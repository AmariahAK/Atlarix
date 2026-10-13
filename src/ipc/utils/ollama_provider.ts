import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { withoutTrailingSlash } from "@ai-sdk/provider-utils";
import type { AtlarixLanguageModel } from "@/ipc/shared/provider-sdk-factories";
import { ollamaNativeFetch } from "./ollama_native_fetch";

type OllamaChatModelId = string;

export interface OllamaProviderOptions {
  /**
   * Base URL for the Ollama API. For real Ollama, use e.g. http://localhost:11434/api
   * The provider will POST to `${baseURL}/chat`.
   * If undefined, defaults to http://localhost:11434/api
   */
  baseURL?: string;
  headers?: Record<string, string>;
  fetch?: FetchFunction;
}

export interface OllamaChatSettings {}

export interface OllamaProvider {
  (
    modelId: OllamaChatModelId,
    settings?: OllamaChatSettings,
  ): AtlarixLanguageModel;
}

export function createOllamaProvider(
  options?: OllamaProviderOptions,
): OllamaProvider {
  const base = withoutTrailingSlash(
    options?.baseURL ?? "http://localhost:11434",
  )!;
  const v1Base = (base.endsWith("/v1") ? base : `${base}/v1`) as string;
  // Chat goes to the native API, the only one that honours a context size
  // (ollama_native_fetch.ts).
  const nativeBase = base.replace(/\/(?:v1|api)$/, "");
  const provider = createOpenAICompatible({
    name: "ollama",
    baseURL: v1Base,
    headers: options?.headers,
    fetch: ollamaNativeFetch(nativeBase, options?.fetch ?? fetch),
    includeUsage: true,
  });
  return (modelId: OllamaChatModelId) => provider(modelId);
}
