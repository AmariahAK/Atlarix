// Leaf module shared by index.ts (CLI entrypoint) and chatCompletionHandler.ts.
// Extracted so the express app can be imported in-process (vitest agent-evals)
// without the side-effectful listen() in index.ts.

/** Helper to create OpenAI-like streaming response chunks. */
export function createStreamChunk(
  content: string,
  role: string = "assistant",
  isLast: boolean = false,
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  },
  /**
   * Overrides the final chunk's `finish_reason`. Real gateways sometimes answer
   * HTTP 200 with a well-formed stream whose finish reason IS the error
   * (`"network_error"`), which is a failure the transport cannot show.
   */
  finishReason?: string,
) {
  const chunk: any = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [
      {
        index: 0,
        delta: isLast ? {} : { content, role },
        finish_reason: isLast ? (finishReason ?? "stop") : null,
      },
    ],
  };

  // Add usage info to the final chunk if provided
  if (isLast && usage) {
    chunk.usage = usage;
  }

  return `data: ${JSON.stringify(chunk)}\n\n${isLast ? "data: [DONE]\n\n" : ""}`;
}

export const CANNED_MESSAGE = `
  <atlarix-write path="file1.txt">
  A file (2)
  </atlarix-write>
  More
  EOM`;
