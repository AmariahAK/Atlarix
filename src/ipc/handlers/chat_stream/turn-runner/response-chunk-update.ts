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
  /** The row this turn streams into — matched by id, see below. Optional so
   * existing callers/tests that never inserted anything mid-turn still work. */
  placeholderAssistantMessage?: { id: number } | null;
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
  // Update the placeholder assistant message content in the messages array.
  //
  // FOUND BY ID, NOT BY POSITION. This used to take
  // `messages[messages.length - 1]` and require `role === "assistant"`, which
  // held only while the placeholder was guaranteed last. A mid-turn user
  // interjection is inserted in FRONT of the placeholder, so the last element
  // becomes the assistant row still — but the array can also carry a user row
  // after it in the ask_user/finalize interleavings, and the failure mode of
  // guessing wrong here is the worst kind: no error, the live assistant text
  // simply stops updating. Identity is the thing we actually have.
  const currentMessages = [...updatedChat.messages];
  const placeholderId = deps.placeholderAssistantMessage?.id;
  const idx =
    placeholderId != null
      ? currentMessages.findIndex((m: any) => m?.id === placeholderId)
      : -1;
  // Fall back to the old rule when there is no id to match (older callers, and
  // the tests that construct a bare chat): last element if it is the assistant.
  const targetIdx =
    idx >= 0
      ? idx
      : currentMessages.length > 0 &&
          currentMessages[currentMessages.length - 1].role === "assistant"
        ? currentMessages.length - 1
        : -1;
  if (targetIdx >= 0) {
    currentMessages[targetIdx].content = fullResponse;
    updatedChat.messages[targetIdx].content = fullResponse;
    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const ec = getStreamTransport(req.chatId);
    if (ec) {
      ec.messages = updatedChat.messages;
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
