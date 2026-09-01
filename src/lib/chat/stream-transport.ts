/**
 * Per-transport TURN BUFFER + binding cache (v12 0.4 contract — see
 * docs/message-store.md).
 *
 * The negative numeric `chatId` keys a single in-memory working `Message[]`
 * plus its `{appId, title}` binding. **The session DB (`chatSessions` +
 * `sessionMessages`) is authoritative for everything cross-turn** (true
 * since 0.4-C2: every persisted message carries its row UUID as
 * `sessionRowId`, and edits target rows directly). This buffer exists only
 * because the streaming turn mutates one array in place and the renderer is
 * driven off `chat:response:chunk` snapshots of it — `get-chat` mid-stream
 * MUST see in-flight chunks the DB does not have yet. It is NOT a store of
 * record; on reload the renderer rehydrates a fresh buffer from
 * `sessions:get`. (Formerly src/lib/ephemeral-chat.ts.)
 */

import log from "electron-log";
import type { Message } from "@/ipc/ipc_types";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";
import { systemReminder } from "@/lib/streaming/system-reminder";

const logger = log.scope("stream-transport");

/**
 * v12 3.1: monotonic message-id counter (seeded from the clock for rough
 * time-ordering). `Date.now()` alone collided when two messages landed in
 * the same millisecond (ask_user answer + continuation, rapid tool notes).
 * Must stay NUMERIC — renderer atoms key messages by numeric id.
 */
let ephemeralMessageIdCounter = Date.now();
export function nextEphemeralMessageId(): number {
  ephemeralMessageIdCounter = Math.max(ephemeralMessageIdCounter + 1, Date.now());
  return ephemeralMessageIdCounter;
}

export function buildContinueAfterQuestionsPrompt(
  msgs: { role: string; content?: string | null }[],
): string {
  // System auto-wake (a background task finished, or a scheduled check fired):
  // the MOST RECENT message is the assistant's own last turn — there is no fresh
  // user input. Re-feeding the user's previous message here makes the model
  // RE-ANSWER an already-answered request on EVERY wake (the "kept repeating the
  // same answer" bug). Instead, orient it to REACT to the new event and continue
  // — exactly how Claude Code reacts to a finished background job rather than
  // re-answering. A genuine question-answer resume (ask_user) inserts the user's
  // answer first, so the last message IS a user message → fall through to the
  // reconstruction below.
  const last = msgs[msgs.length - 1];
  if (last && last.role !== "user") {
    return "(System continuation: a background task finished or a scheduled check fired — its result/advisory is shown above. React to it now: give a brief status update or take the next action, then keep waiting if work remains. Do NOT repeat or re-answer earlier requests — they are already handled.)";
  }
  const userMsgs = msgs.filter((m) => m.role === "user");
  if (userMsgs.length === 0) return "";
  if (userMsgs.length === 1) return String(userMsgs[0].content ?? "").trim();
  const a = String(userMsgs[userMsgs.length - 2]?.content ?? "").trim();
  const b = String(userMsgs[userMsgs.length - 1]?.content ?? "").trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n---\n\n${b}`;
}

/**
 * Model-facing prompt for resuming an interrupted turn (the "Continue" affordance
 * after a disconnect/stop). Wrapped as a `<system-reminder>` so the model reads it
 * as an out-of-band harness resume — NOT a fresh user "continue" turn (which is how
 * the un-framed string used to render in the transcript).
 */
export function buildInterruptedContinuePrompt(): string {
  return systemReminder(
    "Continue from where you left off, without repeating what you already wrote.",
  );
}

export function insertAskUserAnswerUserMessage(
  chatId: number,
  formattedContent: string,
  /** v12 0.4-C3: row UUID from the session persist (direct edit targeting). */
  sessionRowId?: string,
): boolean {
  const chat = ephemeralChats.get(chatId);
  if (!chat) return false;
  const msg: Message = {
    id: nextEphemeralMessageId(),
    chatId,
    role: "user",
    content: formattedContent,
    createdAt: new Date(),
    ...(sessionRowId ? { sessionRowId } : {}),
  };
  chat.messages.push(msg);
  return true;
}

export function editTransportUserMessage(
  chatId: number,
  userMessageId: number,
  newContent: string,
  /** W2 (v14.8.11): regenerated model-facing content — the edited prose with
   * attachment stubs re-expanded to full bodies. Omitted/null = no model
   * variant (plain message). */
  newModelContent?: string | null,
): boolean {
  const chat = ephemeralChats.get(chatId);
  if (!chat) return false;
  const idx = chat.messages.findIndex(
    (m) => m.id === userMessageId && m.role === "user",
  );
  if (idx < 0) return false;
  const prev = chat.messages[idx];
  // v12 3.8: drop per-message derived state on edit — a stale displaySnapshot
  // (frozen sub-agent/tool UI) or modelContent (native-history envelope /
  // attachment bodies) from the pre-edit content must not survive the rewrite.
  // (sessionRowId SURVIVES — the row identity is what the DB edit targets.)
  const {
    displaySnapshot: _staleSnapshot,
    modelContent: _staleModelContent,
    ...rest
  } = prev as Message & { modelContent?: string };
  chat.messages[idx] = {
    ...rest,
    content: newContent,
    ...(newModelContent ? { modelContent: newModelContent } : {}),
  } as Message;
  // Mirror only: the in-memory truncation keeps the live chat:response:chunk
  // snapshot consistent; the AUTHORITATIVE truncation is the DB tail delete
  // in persistEditedSessionMessageById.
  chat.messages = chat.messages.slice(0, idx + 1);
  return true;
}

const ephemeralChats = new Map<
  number,
  {
    id: number;
    title: string;
    messages: Message[];
    createdAt: Date;
    appId?: number;
  }
>();

let ephemeralChatCounter = -1;

/**
 * Seed the counter below the most-negative persisted `streamChatId` at startup.
 * The counter resets to -1 each launch, so without this a freshly-allocated
 * transport id can collide with a *different* session's persisted id, and
 * `allocateSessionTransport` would then reuse one live transport for two
 * sessions (shared message buffer + pending-question state — the cross-session
 * leak). Only ever moves the counter MORE negative; no `db` import here so this
 * module stays renderer-safe (the caller in main does the query).
 */
export function seedEphemeralChatCounterBelow(minPersistedId: number): void {
  if (minPersistedId - 1 < ephemeralChatCounter) {
    ephemeralChatCounter = minPersistedId - 1;
  }
}

export function createStreamTransport(appId: number): number {
  const id = ephemeralChatCounter--;
  ephemeralChats.set(id, {
    id,
    title: "New chat",
    messages: [],
    createdAt: new Date(),
    appId,
  });
  logger.log(`Created ephemeral workspace chat: ${id} for app: ${appId}`);
  return id;
}

export function getStreamTransportAppId(chatId: number): number | undefined {
  return ephemeralChats.get(chatId)?.appId;
}

export function getStreamTransport(chatId: number) {
  return ephemeralChats.get(chatId);
}

export function isStreamTransportId(chatId: number): boolean {
  return chatId < 0;
}

/**
 * v12 (TODO 2.4): drop the in-memory chat entirely when its session is
 * deleted — entries were never pruned, leaking message arrays per deleted
 * session for the lifetime of the main process.
 */
export function deleteStreamTransport(chatId: number): boolean {
  return ephemeralChats.delete(chatId);
}

export function setTransportMessageDisplaySnapshot(
  chatId: number,
  messageId: number,
  snapshot: DisplaySnapshotV1,
): boolean {
  const chat = ephemeralChats.get(chatId);
  if (!chat) return false;
  const idx = chat.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return false;
  chat.messages[idx] = {
    ...chat.messages[idx]!,
    displaySnapshot: snapshot,
  };
  ephemeralChats.set(chatId, chat);
  return true;
}

export function hydrateStreamTransport(
  chatId: number,
  messages: {
    role: string;
    content: string;
    id?: number;
    /** v12 0.4-C2: session DB row UUID (direct edit targeting). */
    sessionRowId?: string | null;
    displaySnapshot?: DisplaySnapshotV1 | null;
    modelContent?: string | null;
    /** Carried so the dispatch slice sees a compaction marker's COLUMN. */
    kind?: import("@/db/schema").SessionMessageKind;
    pasteAttachments?: import("@/ipc/ipc_types").PasteAttachmentMeta[] | null;
    fileAttachments?: import("@/ipc/ipc_types").StoredFileAttachment[] | null;
    attachments?: import("@/ipc/ipc_types").AttachmentInfo[] | null;
    /** Provider's real token total for an assistant turn — the meter's ground
     * truth. Dropped here previously, so a reload silently downgraded the meter
     * to a client-side estimate that reads about half. */
    maxTokensUsed?: number | null;
  }[],
): void {
  const chat = ephemeralChats.get(chatId);
  if (!chat) return;
  chat.messages = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id:
        typeof m.id === "number" && Number.isFinite(m.id)
          ? m.id
          : nextEphemeralMessageId(),
      chatId,
      role: m.role as "user" | "assistant",
      content: m.content ?? "",
      createdAt: new Date(),
      ...(m.sessionRowId ? { sessionRowId: m.sessionRowId } : {}),
      ...(m.modelContent ? { modelContent: m.modelContent } : {}),
      // Only a non-default kind is worth carrying; "message" is the absent case.
      ...(m.kind && m.kind !== "message" ? { kind: m.kind } : {}),
      ...(m.pasteAttachments?.length
        ? { pasteAttachments: m.pasteAttachments }
        : {}),
      ...(m.fileAttachments?.length
        ? { fileAttachments: m.fileAttachments }
        : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.displaySnapshot ? { displaySnapshot: m.displaySnapshot } : {}),
      ...(m.maxTokensUsed != null ? { maxTokensUsed: m.maxTokensUsed } : {}),
    }));
  ephemeralChats.set(chatId, chat);
}

export function appendTransportMessage(
  chatId: number,
  message: {
    role: string;
    content: string;
  },
): void {
  const chat = ephemeralChats.get(chatId);
  if (chat) {
    chat.messages.push({
      ...message,
      id: nextEphemeralMessageId(),
      chatId,
      createdAt: new Date(),
    } as Message);
  }
}

