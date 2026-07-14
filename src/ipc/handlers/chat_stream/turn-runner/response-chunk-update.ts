/**
 * processResponseChunkUpdate — persists the live partial (throttled crash-safe
 * draft), mutates the placeholder assistant message content in the messages
 * array + the stream transport, and emits chat:response:chunk. Extracted
 * verbatim from runStream. Reads only turn config via `deps`; keeps its OWN
 * `fullResponse` parameter (the live accumulated text) — it does NOT read
 * ctx.fullResponse.
 *
 * (Satellite: never imports the parent handler.)
 */

import type { IpcMainInvokeEvent } from "electron";
import { safeSend } from "@/ipc/utils/safe_sender";
import { flushInterruptedDraft } from "@/ipc/handlers/chat_stream/stream-lifecycle";
import { partialResponses } from "@/ipc/handlers/chat_stream/stream-state";
import type { ChatStreamParams } from "@/ipc/ipc_types";

export interface ProcessResponseChunkUpdateDeps {
  req: ChatStreamParams;
  updatedChat: any;
  event: IpcMainInvokeEvent;
  streamId: number;
}

/** Throttle for the live output-token tick (per chat). The real provider usage
 * lands at each onStepFinish; between checkpoints this gives the meter its
 * "ticking up" feel using a cheap char/4 estimate of the reply so far. */
const lastTokenTickAt = new Map<number, number>();
const TOKEN_TICK_INTERVAL_MS = 400;

export async function processResponseChunkUpdate(
  deps: ProcessResponseChunkUpdateDeps,
  { fullResponse }: { fullResponse: string },
): Promise<string> {
  const { req, updatedChat, event, streamId } = deps;
  // Store the current partial response
  partialResponses.set(req.chatId, fullResponse);
  // Issue 4: throttled crash-safe persistence of the partial turn.
  if (req.workspaceSessionId) {
    void flushInterruptedDraft(
      req.chatId,
      req.workspaceSessionId,
      fullResponse,
    );
  }
  // Update the placeholder assistant message content in the messages array
  const currentMessages = [...updatedChat.messages];
  if (
    currentMessages.length > 0 &&
    currentMessages[currentMessages.length - 1].role === "assistant"
  ) {
    currentMessages[currentMessages.length - 1].content = fullResponse;
    {
      const lastIdx = updatedChat.messages.length - 1;
      if (
        lastIdx >= 0 &&
        updatedChat.messages[lastIdx]?.role === "assistant"
      ) {
        updatedChat.messages[lastIdx].content = fullResponse;
        const { getStreamTransport } = await import("@/lib/chat/stream-transport");
        const ec = getStreamTransport(req.chatId);
        if (ec) {
          ec.messages = updatedChat.messages;
        }
      }
    }
  }

  // Update the assistant message in the database
  safeSend(event.sender, "chat:response:chunk", {
    chatId: req.chatId,
    streamId,
    messages: currentMessages,
  });

  // Live token tick — throttled estimate of the reply's output tokens so the
  // meter ticks up between the real per-step usage checkpoints. inputTokens is
  // null here (unknown until the provider reports); the renderer keeps the last
  // real input baseline and just grows the output.
  const now = Date.now();
  const last = lastTokenTickAt.get(req.chatId) ?? 0;
  if (now - last >= TOKEN_TICK_INTERVAL_MS) {
    lastTokenTickAt.set(req.chatId, now);
    safeSend(event.sender, "chat:token-usage", {
      chatId: req.chatId,
      inputTokens: null,
      outputTokens: Math.round(fullResponse.length / 4),
    });
  }
  return fullResponse;
}
