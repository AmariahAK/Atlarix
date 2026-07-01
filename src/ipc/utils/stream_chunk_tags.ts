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

/**
 * Idle timeout: once the model HAS started streaming, abort if no chunk arrives
 * for this long.
 *
 * Raised 45s → 120s → 300s → 600s: open-weight reasoning models (DeepSeek V4
 * Pro, Qwen, Kimi, MiniMax — Atlarix's whole market) pause SILENTLY mid-stream
 * while thinking between steps. Even with `reasoning=true`, OpenRouter/DeepSeek
 * BUFFERS the reasoning server-side and emits NO chunks during the think — so
 * to the watchdog it looks identical to a dead socket. Observed gaps grew from
 * ~50-58s to 127-133s on harder steps (logged: "stalled — no chunk for
 * 132889ms"), repeatedly false-firing even the 120s budget: each kill re-issued
 * the round from the start and re-ran tools already run (the "redoing /
 * duplicate commands" symptom). 600s gives the heaviest silent reasoning ample
 * headroom while still eventually catching a genuinely dead stream; the 180s
 * first-byte budget covers the initial think, and user-cancel stops instantly.
 * The robust fix (continue-from-partial instead of re-issue, via the AI SDK
 * `onAbort` callback) now backs this up: even if a >600s stall does fire, the
 * round resumes from its completed steps rather than restarting from scratch.
 */
export const STREAM_STALL_TIMEOUT_MS = 600_000;
/**
 * First-byte timeout: before the model emits ANYTHING (slow TTFB, or a reasoning
 * model thinking silently — on ANY provider), allow much longer. A model that
 * has produced nothing for this long is genuinely hung/dead, not just slow.
 */
export const STREAM_FIRST_BYTE_TIMEOUT_MS = 180_000;
const HEARTBEAT_LOG_INTERVAL_MS = 15_000;
const TOOL_INPUT_PROGRESS_INTERVAL_MS = 2_000;

/**
 * Adaptive idle-stall budget. Neither opencode nor Claude Code use an adaptive
 * threshold — both rely on generous FIXED idle windows (opencode ~30s chunk /
 * 300s total; CC's 5-min watchdog) plus full-restart retry, and CC found even a
 * fixed 5-min window false-aborts during silent reasoning. The thing that lets
 * Atlarix tighten safely is continue-from-partial (a false abort RESUMES, it
 * doesn't restart). So we only ever tighten toward a generous FLOOR (never below
 * it) for models that have *demonstrated* fast, steady cadence, and keep the 600s
 * ceiling for bursty / server-side-buffering reasoners.
 */
const ADAPTIVE_STALL_MIN_SAMPLES = 10;
/** Never idle-abort a streamed model in under 3 min (= the first-byte budget). */
export const ADAPTIVE_STALL_FLOOR_MS = 180_000;
const ADAPTIVE_STALL_K = 8;
const MAX_GAP_SAMPLES = 50;

/**
 * Idle-stall budget from observed inter-chunk cadence: `clamp(k × p95, floor,
 * ceiling)`. Until enough samples exist, returns the ceiling (today's behavior).
 * Pure + exported for unit testing.
 */
export function computeAdaptiveStallBudget(
  gapsMs: number[],
  opts: { floor: number; ceiling: number; k: number; minSamples?: number },
): number {
  const minSamples = opts.minSamples ?? ADAPTIVE_STALL_MIN_SAMPLES;
  if (gapsMs.length < minSamples) return opts.ceiling;
  const sorted = [...gapsMs].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  // Ceiling is the HARD outer bound (never exceed it — and if a caller passes a
  // ceiling below the floor, e.g. a test injecting a tiny timeout, the ceiling
  // still wins). Floor is the soft minimum for a normal (600s-ceiling) stream.
  return Math.min(opts.ceiling, Math.max(opts.floor, opts.k * p95));
}
/** Faster cadence for the live partial-args preview (feels streaming, bounded IPC). */
const TOOL_INPUT_DELTA_EMIT_MS = 120;

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
  /**
   * Throttled live partial tool-call arguments (the raw JSON text accumulated so
   * far) — lets the UI render a streaming preview (e.g. an edit_file diff
   * building up) BEFORE the tool-call completes. Cleared at tool-call end.
   */
  onToolInputDelta?: (info: {
    toolCallId: string;
    toolName: string;
    argsTextSoFar: string;
  }) => void;
  /** Lightweight pulse for UI scroll / slow-stream timers during silent phases. */
  onStreamActivityPulse?: () => void;
  /** Idle timeout once chunks have started flowing. */
  stallTimeoutMs?: number;
  /** Grace before the FIRST chunk (slow TTFB / silent reasoning) — any provider. */
  firstByteTimeoutMs?: number;
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
  onToolInputDelta,
  onStreamActivityPulse,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
  firstByteTimeoutMs = STREAM_FIRST_BYTE_TIMEOUT_MS,
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
  /** Whether the model has emitted any part yet — gates first-byte vs idle budget. */
  let hasReceivedChunk = false;
  /** Rolling inter-chunk gaps (ms) for the adaptive idle-stall budget. */
  const chunkGaps: number[] = [];
  /** Tools currently executing locally (tool-call seen, tool-result pending). */
  let toolExecutionInFlight = 0;
  let lastHeartbeatLogAt = Date.now();
  let loggedHallucinatedTag = false;
  const partCounts: Record<string, number> = {};
  const streamStartedAt = Date.now();
  let pendingInputToolName: string | undefined;
  let toolInputDeltaCount = 0;
  let lastToolInputNotifyAt = 0;
  // Per tool-call accumulator of the raw JSON argument text streamed so far, so
  // the UI can render a live preview before the tool-call completes.
  const toolInputBuffers = new Map<string, { toolName: string; text: string }>();
  let lastToolInputDeltaEmitAt = 0;
  const streamDebug = isStreamDebugLoggingEnabled();

  const emitToolInputDelta = (toolCallId: string, force = false) => {
    if (!onToolInputDelta) return;
    const buf = toolInputBuffers.get(toolCallId);
    if (!buf) return;
    const now = Date.now();
    if (!force && now - lastToolInputDeltaEmitAt < TOOL_INPUT_DELTA_EMIT_MS) return;
    lastToolInputDeltaEmitAt = now;
    onToolInputDelta({ toolCallId, toolName: buf.toolName, argsTextSoFar: buf.text });
  };

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
      // Keep the renderer's activity clock fresh while a long tool runs (a
      // 60s+ command, a sub-agent) so it shows "still working", not a false
      // "Reconnecting…". The tool enforces its own timeout; this is display-only.
      onStreamActivityPulse?.();
      return;
    }
    const now = Date.now();
    const sinceChunk = now - lastChunkAt;
    // Before the first chunk (slow TTFB / silent reasoning) allow a generous
    // first-byte budget; once the model has started streaming, a shorter idle
    // budget catches a genuinely dropped/dead connection. Provider-agnostic.
    const budget = hasReceivedChunk
      ? computeAdaptiveStallBudget(chunkGaps, {
          floor: ADAPTIVE_STALL_FLOOR_MS,
          ceiling: stallTimeoutMs,
          k: ADAPTIVE_STALL_K,
        })
      : firstByteTimeoutMs;
    if (sinceChunk >= budget) {
      stalled = true;
      logger.warn(
        `[stream] chat ${chatId} stalled — no chunk for ${sinceChunk}ms (${
          hasReceivedChunk ? "idle" : "first-byte"
        } budget ${budget}ms)`,
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
    // Tick at most every 15s, but never coarser than the smallest active budget
    // (tests inject small timeouts; production stays checked every 15s).
  }, Math.max(10, Math.min(stallTimeoutMs, firstByteTimeoutMs, HEARTBEAT_LOG_INTERVAL_MS)));

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
      const partAt = Date.now();
      // Sample the inter-chunk gap (skip the first-byte TTFB, which is not a
      // cadence signal) to feed the adaptive idle-stall budget.
      if (hasReceivedChunk) {
        chunkGaps.push(partAt - lastChunkAt);
        if (chunkGaps.length > MAX_GAP_SAMPLES) chunkGaps.shift();
      }
      lastChunkAt = partAt;
      hasReceivedChunk = true; // model has started responding → idle budget applies
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
        const startId = (part as { toolCallId?: string }).toolCallId;
        if (startId && toolKey) {
          toolInputBuffers.set(startId, {
            toolName: parseMcpToolKey(toolKey).toolName || toolKey,
            text: "",
          });
        }
        toolInputDeltaCount = 0;
        markFirstModelActivity();
        notifyToolInputProgress(true);
      } else if (part.type === "tool-input-delta") {
        toolInputDeltaCount += 1;
        const deltaId = (part as { toolCallId?: string }).toolCallId;
        const deltaText = (part as { inputTextDelta?: string }).inputTextDelta;
        if (deltaId && typeof deltaText === "string") {
          const buf = toolInputBuffers.get(deltaId);
          if (buf) {
            buf.text += deltaText;
            emitToolInputDelta(deltaId, false);
          }
        }
        markFirstModelActivity();
        notifyToolInputProgress(false);
      } else if (part.type === "tool-input-end") {
        const endId = (part as { toolCallId?: string }).toolCallId;
        if (endId) toolInputBuffers.delete(endId);
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
        // Final args are authoritative now — drop the partial buffer so the UI
        // stops showing the streaming preview for this call.
        const callId = (part as { toolCallId?: string }).toolCallId;
        if (callId) toolInputBuffers.delete(callId);
        toolExecutionInFlight += 1;
        markFirstModelActivity();
        // A tool now runs and will emit no stream chunks until it returns — pulse
        // immediately so the renderer's activity clock resets before the tool's
        // (possibly long) execution, and keep pulsing from the stall timer below.
        onStreamActivityPulse?.();
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
