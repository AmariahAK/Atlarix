/**
 * The transcript half of a mid-turn message — and the regression it can cause.
 *
 * THE HAZARD. `processResponseChunkUpdate` and the ask_user branch of
 * `handleTurnError` both used to find the streaming assistant row as
 * `messages[messages.length - 1]`. Inserting a user row mid-turn breaks that
 * assumption, and the failure is the silent kind: no error, the live assistant
 * text simply stops updating. Both now match by id, and these tests are what
 * keep them honest — the first two pin the insert, the last pins that streaming
 * still lands on the right row with a user message present.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createStreamTransport,
  getStreamTransport,
  deleteStreamTransport,
  insertUserInterjectionMessage,
  nextEphemeralMessageId,
} from "@/lib/chat/stream-transport";
import { processResponseChunkUpdate } from "@/ipc/handlers/chat_stream/turn-runner/response-chunk-update";

let chatId: number;
let placeholderId: number;

function seedTurn() {
  chatId = createStreamTransport(1);
  const chat = getStreamTransport(chatId)!;
  placeholderId = nextEphemeralMessageId();
  chat.messages = [
    {
      id: nextEphemeralMessageId(),
      chatId,
      role: "user",
      content: "build the thing",
      createdAt: new Date(),
    },
    {
      id: placeholderId,
      chatId,
      role: "assistant",
      content: "",
      createdAt: new Date(),
    },
  ] as never;
}

describe("mid-turn user message → transcript", () => {
  beforeEach(() => {
    seedTurn();
  });

  it("inserts IN FRONT of the streaming placeholder", () => {
    insertUserInterjectionMessage(chatId, "actually use Postgres", placeholderId);
    const roles = getStreamTransport(chatId)!.messages.map((m) => m.role);
    // The placeholder keeps growing, so the user's row has to precede it or the
    // assistant's continuation would render above the message it responds to.
    expect(roles).toEqual(["user", "user", "assistant"]);
    expect(getStreamTransport(chatId)!.messages[1]!.content).toBe(
      "actually use Postgres",
    );
    deleteStreamTransport(chatId);
  });

  it("appends when the placeholder is already gone (turn finalized mid-flight)", () => {
    const chat = getStreamTransport(chatId)!;
    chat.messages = chat.messages.filter((m) => m.id !== placeholderId);
    insertUserInterjectionMessage(chatId, "late one", placeholderId);
    expect(chat.messages[chat.messages.length - 1]!.content).toBe("late one");
    deleteStreamTransport(chatId);
  });

  it("carries the session row id through, so the row stays editable", () => {
    insertUserInterjectionMessage(chatId, "text", placeholderId, "row-uuid-1");
    const inserted = getStreamTransport(chatId)!.messages[1]!;
    expect(inserted.sessionRowId).toBe("row-uuid-1");
    deleteStreamTransport(chatId);
  });

  it("REGRESSION: live assistant text keeps updating with a user row present", async () => {
    insertUserInterjectionMessage(chatId, "and add tests", placeholderId);
    const chat = getStreamTransport(chatId)!;
    const updatedChat = { id: chatId, messages: chat.messages };
    const sent: unknown[] = [];
    const event = {
      sender: { isDestroyed: () => false, send: (_c: string, p: unknown) => sent.push(p) },
    };

    await processResponseChunkUpdate(
      {
        req: { chatId } as never,
        updatedChat,
        event: event as never,
        streamId: 1,
        placeholderAssistantMessage: { id: placeholderId },
      },
      { fullResponse: "streaming words" },
    );

    // The ASSISTANT row got the text — not the last element (which is the
    // assistant here) by luck, but the row whose id we streamed into.
    const placeholder = chat.messages.find((m) => m.id === placeholderId)!;
    expect(placeholder.content).toBe("streaming words");
    // And the user's message is untouched beside it.
    expect(chat.messages.some((m) => m.content === "and add tests")).toBe(true);
    deleteStreamTransport(chatId);
  });

  it("REGRESSION: streaming still lands when a user row is LAST", async () => {
    // The position guard's worst case: the array does not end in the assistant
    // row at all. By position this wrote nothing; by id it still works.
    const chat = getStreamTransport(chatId)!;
    chat.messages.push({
      id: nextEphemeralMessageId(),
      chatId,
      role: "user",
      content: "trailing",
      createdAt: new Date(),
    } as never);
    const updatedChat = { id: chatId, messages: chat.messages };
    const event = {
      sender: { isDestroyed: () => false, send: () => {} },
    };
    await processResponseChunkUpdate(
      {
        req: { chatId } as never,
        updatedChat,
        event: event as never,
        streamId: 1,
        placeholderAssistantMessage: { id: placeholderId },
      },
      { fullResponse: "still streaming" },
    );
    expect(chat.messages.find((m) => m.id === placeholderId)!.content).toBe(
      "still streaming",
    );
    deleteStreamTransport(chatId);
  });
});
