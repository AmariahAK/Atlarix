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
  return fullResponse;
}
