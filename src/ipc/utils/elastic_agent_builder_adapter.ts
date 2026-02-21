/**
 * Elastic Agent Builder (Kibana) adapter for Atlarix
 * Uses Kibana REST API: POST /api/agent_builder/converse
 * Docs: https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/kibana-api
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";

export interface ElasticAgentBuilderConfig {
  baseUrl: string;
  apiKey: string;
  space?: string;
  agentId: string;
}

function buildConverseUrl(baseUrl: string, space?: string): string {
  const base = baseUrl.replace(/\/$/, "");
  if (space && space.trim()) {
    return `${base}/s/${encodeURIComponent(space.trim())}/api/agent_builder/converse`;
  }
  return `${base}/api/agent_builder/converse`;
}

function promptToInput(prompt: LanguageModelV2CallOptions["prompt"]): string {
  const parts: string[] = [];
  for (const msg of prompt) {
    if (msg.role === "system") {
      parts.push(`System: ${msg.content}`);
    } else if (msg.role === "user") {
      const content = Array.isArray(msg.content)
        ? msg.content
          .filter((p) => p.type === "text")
          .map((p) => ("text" in p ? p.text : ""))
          .join(" ")
        : String(msg.content);
      parts.push(content);
    } else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content)
        ? msg.content
          .filter((p) => p.type === "text")
          .map((p) => ("text" in p ? p.text : ""))
          .join(" ")
        : "";
      if (content) parts.push(content);
    }
  }
  return parts.join("\n\n").trim() || "Hello";
}

export function createElasticAgentBuilderModel(
  config: ElasticAgentBuilderConfig
): LanguageModelV2 {
  const { baseUrl, apiKey, space, agentId } = config;
  const converseUrl = buildConverseUrl(baseUrl, space);

  const doGenerate: LanguageModelV2["doGenerate"] = async (options) => {
    const input = promptToInput(options.prompt);
    const res = await fetch(converseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${apiKey}`,
        "kbn-xsrf": "true",
      },
      body: JSON.stringify({
        input,
        agent_id: agentId,
      }),
      signal: options.abortSignal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Elastic Agent Builder: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as {
      response?: string;
      conversation_id?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = data.response ?? "";
    const usage: LanguageModelV2Usage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    };
    const content: LanguageModelV2Content[] = text
      ? [{ type: "text" as const, text }]
      : [];

    return {
      content,
      finishReason: "stop" as LanguageModelV2FinishReason,
      usage,
      warnings: [],
    };
  };

  const doStream: LanguageModelV2["doStream"] = async (options) => {
    const result = await doGenerate(options);
    const text = result.content.find((c) => c.type === "text");
    const textValue = text && "text" in text ? text.text : "";

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", providerMetadata: undefined });
        if (textValue) {
          controller.enqueue({ type: "text-delta", textDelta: textValue });
        }
        controller.enqueue({
          type: "finish",
          usage: result.usage,
          finishReason: result.finishReason,
          providerMetadata: result.providerMetadata,
        });
        controller.close();
      },
    });

    return { stream };
  };

  return {
    specificationVersion: "v2",
    provider: "elastic-agent-builder",
    modelId: agentId,
    supportedUrls: {},
    doGenerate,
    doStream,
  };
}
