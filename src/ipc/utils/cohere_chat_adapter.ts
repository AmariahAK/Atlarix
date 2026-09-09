import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";

type CohereChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: unknown }
  | { role: "tool"; tool_call_id: string; content: unknown };

function cohereMessageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";

  // Cohere v2 message content can be a list of content blocks.
  // We only extract text blocks so we can render and parse tool XML downstream.
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const type = (block as { type?: unknown }).type;
      if (type === "text") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") texts.push(t);
      }
    }
    return texts.join("");
  }

  return "";
}

function promptToCohereMessages(
  prompt: LanguageModelV2CallOptions["prompt"],
): CohereChatMessage[] {
  const msgs: CohereChatMessage[] = [];

  for (const msg of prompt) {
    if (msg.role === "system") {
      msgs.push({ role: "system", content: String(msg.content ?? "") });
      continue;
    }
    if (msg.role === "user") {
      const content = Array.isArray(msg.content)
        ? msg.content
            .filter((p) => p.type === "text")
            .map((p) => ("text" in p ? p.text : ""))
            .join(" ")
        : String(msg.content ?? "");
      msgs.push({ role: "user", content });
      continue;
    }
    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content)
        ? msg.content
            .filter((p) => p.type === "text")
            .map((p) => ("text" in p ? p.text : ""))
            .join(" ")
        : typeof msg.content === "string"
          ? msg.content
          : "";
      msgs.push({ role: "assistant", content });
      continue;
    }
  }

  return msgs;
}

export function createCohereChatModel(params: {
  apiKey: string;
  modelId: string;
}): LanguageModelV2 {
  const { apiKey, modelId } = params;

  const doGenerate: LanguageModelV2["doGenerate"] = async (options) => {
    const messages = promptToCohereMessages(options.prompt);

    const res = await fetch("https://api.cohere.com/v2/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        stream: false,
        messages,
      }),
      signal: options.abortSignal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Cohere: ${res.status} ${errText}`.trim());
    }

    const data = (await res.json()) as {
      message?: { content?: unknown };
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = cohereMessageContentToText(data.message?.content);

    const usage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      totalTokens:
        (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    } as LanguageModelV2Usage;

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
        controller.enqueue({
          type: "text-start",
          id: "cohere-1",
          providerMetadata: undefined,
        });
        if (textValue) {
          controller.enqueue({
            type: "text-delta",
            id: "cohere-1",
            delta: textValue,
          });
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
    provider: "cohere",
    modelId,
    supportedUrls: {},
    doGenerate,
    doStream,
  };
}
