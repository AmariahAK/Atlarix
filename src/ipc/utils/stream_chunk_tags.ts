import {
  type TextStreamPart,
  type ToolSet,
} from "ai";
import log from "electron-log";
import { AI_STREAM_EMPTY_RESPONSE_FALLBACK } from "@/shared/texts";
import { isNoUsableModelOutputError } from "../utils/no_usable_model_output";
import { cleanFullResponse } from "../utils/cleanFullResponse";
import { escapeAtlarixTags } from "../utils/escape_atlarix_tags";
import { isStreamDebugLoggingEnabled } from "@/lib/stream/stream-debug";

const logger = log.scope("stream-chunk-tags");

/** Abort stream when no chunk arrives for this long (ms). */
export const STREAM_STALL_TIMEOUT_MS = 45_000;
const HEARTBEAT_LOG_INTERVAL_MS = 15_000;
const TOOL_INPUT_PROGRESS_INTERVAL_MS = 2_000;

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
  /** Called when no stream chunk arrives within STREAM_STALL_TIMEOUT_MS. */
  onStreamStall?: () => void;
  /** Throttled while model streams native tool arguments (tool-input-delta). */
  onToolInputProgress?: (info: {
    toolName: string;
    deltaCount: number;
  }) => void;
  /** Lightweight pulse for UI scroll / slow-stream timers during silent phases. */
  onStreamActivityPulse?: () => void;
  stallTimeoutMs?: number;
};

function detectHallucinatedAtlarixToolTag(text: string): boolean {
  return (
    /<atlarix-tool_calls\b/i.test(text) ||
    /<atlarix-tool-call\b/i.test(text)
  );
}

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
  onStreamStall,
  onToolInputProgress,
  onStreamActivityPulse,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
}: ProcessStreamChunksParams): Promise<{
  fullResponse: string;
  incrementalResponse: string;
  stalled: boolean;
  finishReason?: string;
}> {
  let fullResponse = initialFullResponse;
  let incrementalResponse = "";
  let inThinkingBlock = false;
  let firstModelActivitySent = false;
  let firstTextDeltaSent = false;
  let firstReasoningActivitySent = false;
  let reasoningStreamActive = false;
  let stalled = false;
  let finishReason: string | undefined;
  let lastChunkAt = Date.now();
  /** Tools currently executing locally (tool-call seen, tool-result pending). */
  let toolExecutionInFlight = 0;
  let lastHeartbeatLogAt = Date.now();
  let loggedHallucinatedTag = false;
  const partCounts: Record<string, number> = {};
  const streamStartedAt = Date.now();
  let pendingInputToolName: string | undefined;
  let toolInputDeltaCount = 0;
  let lastToolInputNotifyAt = 0;
  const streamDebug = isStreamDebugLoggingEnabled();

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

  const notifyToolInputProgress = (force = false) => {
    if (!onToolInputProgress && !onStreamActivityPulse) return;
    const now = Date.now();
    if (!force && now - lastToolInputNotifyAt < TOOL_INPUT_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastToolInputNotifyAt = now;
    const toolName = pendingInputToolName ?? "tool";
    onToolInputProgress?.({ toolName, deltaCount: toolInputDeltaCount });
    onStreamActivityPulse?.();
  };

  const stallTimer = setInterval(() => {
    if (abortController.signal.aborted) return;
    // v10.1: a locally-executing tool (sub-agent delegation, long run_command,
    // ask_user waiting for the user) produces NO stream chunks by design — the
    // model resumes only after the tool returns. Don't treat that as a stall;
    // tools enforce their own timeouts.
    if (toolExecutionInFlight > 0) {
      lastChunkAt = Date.now();
      return;
    }
    const now = Date.now();
    const sinceChunk = now - lastChunkAt;
    if (sinceChunk >= stallTimeoutMs) {
      stalled = true;
      logger.warn(
        `[stream] chat ${chatId} stalled — no chunk for ${sinceChunk}ms`,
      );
      onStreamStall?.();
      abortController.abort();
      return;
    }
    if (
      streamDebug &&
      now - lastHeartbeatLogAt >= HEARTBEAT_LOG_INTERVAL_MS
    ) {
      lastHeartbeatLogAt = now;
      logger.log(
        `[stream heartbeat] chat ${chatId} active — ${sinceChunk}ms since last chunk (parts: ${JSON.stringify(partCounts)})`,
      );
    }
    // Tick at most every 15s, but never coarser than the stall timeout itself
    // (tests inject small timeouts; production stays 45s checked every 15s).
  }, Math.max(10, Math.min(stallTimeoutMs, HEARTBEAT_LOG_INTERVAL_MS)));

  // v10.1: provider-executed search citations. Anthropic/Gemini native search
  // emit `source` parts; Gemini grounding also surfaces via finish-step
  // providerMetadata. Collected sources flush as one <atlarix-sources> tag at
  // stream end — persisted in message content, so citations survive reload.
  const collectedSources = new Map<string, { url: string; title: string }>();
  const collectSource = (url: unknown, title: unknown) => {
    if (typeof url !== "string" || !url.trim()) return;
    if (!collectedSources.has(url)) {
      collectedSources.set(url, {
        url,
        title: typeof title === "string" && title.trim() ? title : url,
      });
    }
  };

  try {
    for await (const part of fullStream) {
      lastChunkAt = Date.now();
      partCounts[part.type] = (partCounts[part.type] ?? 0) + 1;

      if (part.type === "source") {
        const src = part as { sourceType?: string; url?: string; title?: string };
        if (src.sourceType === "url") collectSource(src.url, src.title);
      }

      if (part.type === "tool-error") {
        toolExecutionInFlight = Math.max(0, toolExecutionInFlight - 1);
      }

      if (part.type === "finish-step") {
        // Safety: never let a missed tool-result keep the stall guard off.
        toolExecutionInFlight = 0;
        // Gemini grounding backup path: groundingChunks in providerMetadata.
        const meta = (part as { providerMetadata?: Record<string, unknown> })
          .providerMetadata;
        const grounding = (meta?.google as
          | { groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } }
          | undefined)?.groundingMetadata;
        for (const chunk of grounding?.groundingChunks ?? []) {
          collectSource(chunk?.web?.uri, chunk?.web?.title);
        }
      }

      if (part.type === "finish") {
        finishReason =
          typeof (part as { finishReason?: string }).finishReason === "string"
            ? (part as { finishReason?: string }).finishReason
            : undefined;
      }

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

      if (part.type === "tool-input-start") {
        const toolKey =
          typeof (part as { toolName?: string }).toolName === "string"
            ? (part as { toolName: string }).toolName
            : undefined;
        if (toolKey) {
          pendingInputToolName = parseMcpToolKey(toolKey).toolName || toolKey;
        }
        toolInputDeltaCount = 0;
        markFirstModelActivity();
        notifyToolInputProgress(true);
      } else if (part.type === "tool-input-delta") {
        toolInputDeltaCount += 1;
        markFirstModelActivity();
        notifyToolInputProgress(false);
      } else if (part.type === "text-delta") {
        let text = part.text ?? "";
        if (sanitizeTextDelta) {
          text = sanitizeTextDelta(text);
        }
        if (
          text &&
          detectHallucinatedAtlarixToolTag(text) &&
          !loggedHallucinatedTag
        ) {
          loggedHallucinatedTag = true;
          if (streamDebug) {
            logger.warn(
              `[stream] chat ${chatId}: model emitted raw Atlarix tool tag in text-delta`,
            );
          }
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
        pendingInputToolName = undefined;
        toolInputDeltaCount = 0;
        toolExecutionInFlight += 1;
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
        toolExecutionInFlight = Math.max(0, toolExecutionInFlight - 1);
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
        if (streamDebug) {
          logger.log(`Stream for chat ${chatId} was aborted`);
        }
        break;
      }
    }
  } catch (err) {
    if (abortController.signal.aborted && stalled) {
      logger.warn(`Stream for chat ${chatId} aborted due to stall`);
    } else if (isNoUsableModelOutputError(err) && !abortController.signal.aborted) {
      logger.warn(
        `Stream for chat ${chatId} produced no usable text (mapped to fallback):`,
        err,
      );
      if (!fullResponse.trim()) {
        await applyEmptyFallback();
      }
    } else if (!abortController.signal.aborted) {
      throw err;
    }
  } finally {
    clearInterval(stallTimer);
    if (streamDebug) {
      logger.log(
        `[stream heartbeat] chat ${chatId} ended — duration ${Date.now() - streamStartedAt}ms stalled=${stalled} finish=${finishReason ?? "n/a"} parts=${JSON.stringify(partCounts)}`,
      );
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

  // Flush provider-native search citations into message content (reload-stable).
  if (!abortController.signal.aborted && collectedSources.size > 0) {
    const payload = escapeAtlarixTags(
      JSON.stringify(Array.from(collectedSources.values())),
    );
    const sourcesChunk = `\n<atlarix-sources>${payload}</atlarix-sources>\n`;
    fullResponse += sourcesChunk;
    incrementalResponse += sourcesChunk;
    fullResponse = cleanFullResponse(fullResponse);
    fullResponse = await processResponseChunkUpdate({ fullResponse });
  }

  if (!abortController.signal.aborted && !fullResponse.trim()) {
    await applyEmptyFallback();
  }

  return { fullResponse, incrementalResponse, stalled, finishReason };
}
