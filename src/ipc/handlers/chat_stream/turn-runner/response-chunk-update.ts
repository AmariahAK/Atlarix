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
import { safeSend, safeSendCoalesced } from "@/ipc/utils/safe_sender";
import { flushInterruptedDraft } from "@/ipc/handlers/chat_stream/stream-lifecycle";
import {
  activeStreamId,
  activeStreams,
  partialResponses,
} from "@/ipc/handlers/chat_stream/stream-state";
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

/**
 * The stream (per chat) whose receiver already holds the full message list.
 *
 * Sending the whole list on every token cost O(turn²) bytes over IPC — each
 * chunk carried every earlier message's frozen tool cards too — and was the main
 * cause of the desktop app's memory climbing during a long Build turn. The list
 * now goes once per stream (and again whenever another path sends it); after
 * that each chunk is a `patch` with only the live row's text, coalesced to one
 * per 50 ms. Receivers apply the patch to the last list they were sent.
 */
const fullListSentFor = new Map<number, number>();
const CHUNK_WINDOW_MS = 50;

/** The live row's text as the receiver last got it, per chat. */
const liveTextSent = new Map<number, string>();

/**
 * The change from what the receiver holds to `next`: everything from the first
 * differing character on. Almost always an append, so `text` is the few new
 * characters; when an earlier part was rewritten (cleanFullResponse's dedupe),
 * it starts there instead. `length` lets the receiver check it applied the patch
 * to the same base.
 */
export function liveTextPatch(
  prev: string,
  next: string,
): { start: number; text: string; length: number } {
  let start = 0;
  if (next.startsWith(prev)) {
    start = prev.length;
  } else {
    const max = Math.min(prev.length, next.length);
    while (start < max && prev.charCodeAt(start) === next.charCodeAt(start))
      start++;
  }
  return { start, text: next.slice(start), length: next.length };
}
const TOKEN_TICK_INTERVAL_MS = 400;

export async function processResponseChunkUpdate(
  deps: ProcessResponseChunkUpdateDeps,
  { fullResponse }: { fullResponse: string },
): Promise<string> {
  const { req, updatedChat, event, streamId } = deps;
  // A chunk that lands after the turn was stopped is not this turn's record any
  // more: the stopped row (with its note for the model) is. Kept, it wrote a
  // second row without the note, and a resumed chat re-ran the stopped request
  // (QA 15.7.1 #11).
  const live =
    activeStreams.has(req.chatId) &&
    activeStreamId.get(req.chatId) === streamId;
  // Store the current partial response
  if (live) partialResponses.set(req.chatId, fullResponse);
  // Issue 4: throttled crash-safe persistence of the partial turn.
  if (live && req.workspaceSessionId) {
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

  if (
    targetIdx >= 0 &&
    placeholderId != null &&
    fullListSentFor.get(req.chatId) === streamId
  ) {
    const chatId = req.chatId;
    safeSendCoalesced(
      event.sender,
      "chat:response:chunk",
      chatId,
      () => {
        const patch = liveTextPatch(
          liveTextSent.get(chatId) ?? "",
          fullResponse,
        );
        liveTextSent.set(chatId, fullResponse);
        return {
          chatId,
          streamId,
          patch: { messageId: placeholderId, ...patch },
        };
      },
      CHUNK_WINDOW_MS,
    );
  } else {
    safeSend(event.sender, "chat:response:chunk", {
      chatId: req.chatId,
      streamId,
      messages: currentMessages,
    });
    fullListSentFor.set(req.chatId, streamId);
    if (targetIdx >= 0) liveTextSent.set(req.chatId, fullResponse);
  }

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
