import {
  type TextStreamPart,
  type ToolSet,
} from "ai";
import log from "electron-log";
import { AI_STREAM_EMPTY_RESPONSE_FALLBACK } from "@/shared/texts";
import { isNoUsableModelOutputError } from "../utils/no_usable_model_output";
import { cleanFullResponse } from "../utils/cleanFullResponse";
import { escapeAtlarixTags } from "../utils/escape_atlarix_tags";

const logger = log.scope("stream-chunk-tags");

type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;

/** Parse MCP composite tool keys (`server__tool`). */
export function parseMcpToolKey(toolKey: string): {
  serverName: string;
  toolName: string;
} {
  const separator = "__";
  const lastIndex = toolKey.lastIndexOf(separator);
  if (lastIndex === -1) {
    return { serverName: "", toolName: toolKey };
  }
  return {
    serverName: toolKey.slice(0, lastIndex),
    toolName: toolKey.slice(lastIndex + separator.length),
  };
}

export type ProcessStreamChunksParams = {
  fullStream: AsyncIterableStream<TextStreamPart<ToolSet>>;
  fullResponse: string;
  abortController: AbortController;
  chatId: number;
  processResponseChunkUpdate: (params: {
    fullResponse: string;
  }) => Promise<string>;
  /** Optional sanitizer for text-delta (chat-only strips legacy XML tool syntax). */
  sanitizeTextDelta?: (text: string) => string;
  onFirstModelActivity?: () => void;
  onFirstTextDelta?: () => void;
  onFirstReasoningDelta?: () => void;
  onFirstTextAfterReasoning?: () => void;
  /** @deprecated Stall watchdog removed */
  onStreamStall?: () => void;
};

/** Map AI SDK stream parts to atlarix inline tags in assistant content. */
export async function processStreamChunks({
  fullStream,
  fullResponse: initialFullResponse,
  abortController,
  chatId,
  processResponseChunkUpdate,
  sanitizeTextDelta,
  onFirstModelActivity,
  onFirstTextDelta,
  onFirstReasoningDelta,
  onFirstTextAfterReasoning,
}: ProcessStreamChunksParams): Promise<{
  fullResponse: string;
  incrementalResponse: string;
}> {
  let fullResponse = initialFullResponse;
  let incrementalResponse = "";
  let inThinkingBlock = false;
  let firstModelActivitySent = false;
  let firstTextDeltaSent = false;
  let firstReasoningActivitySent = false;
  let reasoningStreamActive = false;

  const markFirstModelActivity = () => {
    if (firstModelActivitySent || !onFirstModelActivity) return;
    firstModelActivitySent = true;
    onFirstModelActivity();
  };

  const applyEmptyFallback = async () => {
    const fb = AI_STREAM_EMPTY_RESPONSE_FALLBACK;
    fullResponse += fb;
    incrementalResponse += fb;
    fullResponse = cleanFullResponse(fullResponse);
    fullResponse = await processResponseChunkUpdate({ fullResponse });
  };

  let pendingToolCallDepth = 0;

  try {
    for await (const part of fullStream) {
      let chunk = "";
      if (
        inThinkingBlock &&
        !["reasoning-delta", "reasoning-start", "reasoning-end"].includes(
          part.type,
        )
      ) {
        chunk = "</think>";
        inThinkingBlock = false;
      }

      if (part.type === "text-delta") {
        let text = part.text ?? "";
        if (sanitizeTextDelta) {
          text = sanitizeTextDelta(text);
        }
        if (text) {
          if (reasoningStreamActive && onFirstTextAfterReasoning) {
            onFirstTextAfterReasoning();
            reasoningStreamActive = false;
          }
          if (!firstTextDeltaSent && onFirstTextDelta) {
            firstTextDeltaSent = true;
            onFirstTextDelta();
          }
          markFirstModelActivity();
        }
        chunk += text;
      } else if (part.type === "reasoning-delta") {
        const rtext = typeof part.text === "string" ? part.text : "";
        if (rtext && !firstReasoningActivitySent && onFirstReasoningDelta) {
          firstReasoningActivitySent = true;
          onFirstReasoningDelta();
          reasoningStreamActive = true;
        }
        if (rtext) {
          if (!inThinkingBlock) {
            chunk = "<think>";
            inThinkingBlock = true;
          }
          chunk += escapeAtlarixTags(rtext);
        }
      } else if (part.type === "tool-call") {
        pendingToolCallDepth += 1;
        markFirstModelActivity();
        const toolKey =
          typeof part.toolName === "string" ? part.toolName : "tool";
        const { serverName, toolName } = parseMcpToolKey(toolKey);
        const content = escapeAtlarixTags(JSON.stringify(part.input));
        if (!serverName || serverName === toolName) {
          chunk = `<atlarix-tool-call tool="${toolName}" status="running">\n${content}\n</atlarix-tool-call>\n`;
        } else {
          chunk = `<atlarix-mcp-tool-call server="${serverName}" tool="${toolName}">\n${content}\n</atlarix-mcp-tool-call>\n`;
        }
      } else if (part.type === "tool-result") {
        pendingToolCallDepth = Math.max(0, pendingToolCallDepth - 1);
        markFirstModelActivity();
        const toolKey =
          typeof part.toolName === "string" ? part.toolName : "tool";
        const { serverName, toolName } = parseMcpToolKey(toolKey);
        const content = escapeAtlarixTags(
          typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output),
        );
        if (!serverName || serverName === toolName) {
          chunk = `<atlarix-tool-result tool="${toolName}" status="complete">\n${content}\n</atlarix-tool-result>\n`;
        } else {
          chunk = `<atlarix-mcp-tool-result server="${serverName}" tool="${toolName}">\n${content}\n</atlarix-mcp-tool-result>\n`;
        }
      }

      if (!chunk) continue;

      fullResponse += chunk;
      incrementalResponse += chunk;
      fullResponse = cleanFullResponse(fullResponse);
      fullResponse = await processResponseChunkUpdate({ fullResponse });

      if (abortController.signal.aborted) {
        logger.log(`Stream for chat ${chatId} was aborted`);
        break;
      }
    }
  } catch (err) {
    if (isNoUsableModelOutputError(err) && !abortController.signal.aborted) {
      logger.warn(
        `Stream for chat ${chatId} produced no usable text (mapped to fallback):`,
        err,
      );
      if (!fullResponse.trim()) {
        await applyEmptyFallback();
      }
    } else {
      throw err;
    }
  }

  if (inThinkingBlock) {
    const flushChunk = "</think>";
    fullResponse += flushChunk;
    incrementalResponse += flushChunk;
    inThinkingBlock = false;
    fullResponse = cleanFullResponse(fullResponse);
    fullResponse = await processResponseChunkUpdate({ fullResponse });
  }

  if (!abortController.signal.aborted && !fullResponse.trim()) {
    await applyEmptyFallback();
  }

  return { fullResponse, incrementalResponse };
}
