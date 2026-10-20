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
  ephemeralMessageIdCounter = Math.max(
    ephemeralMessageIdCounter + 1,
    Date.now(),
  );
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

/**
 * Insert a mid-turn user message (an "interjection") into the live turn buffer,
 * positioned BEFORE the streaming assistant placeholder.
 *
 * WHY BEFORE, not appended. The placeholder keeps growing as the model writes,
 * so a user row appended after it would end up above nothing and then have the
 * continuation appear above itself. Before the placeholder, the transcript reads
 * "…earlier turns, your message, what the assistant is saying now", which is
 * what the owner asked for ("insert live, before the placeholder").
 *
 * ID ORDER vs DISPLAY ORDER. `chat_stream_handlers` mints the turn's user id
 * before the placeholder's specifically so id order matches array order — and
 * this is the one message that cannot honour that, since it is minted after the
 * turn began. It is safe because nothing CONSUMES id order: the renderer paints
 * `messages` in array order and keys rows by id for identity only (verified —
 * no id comparison or sort anywhere in the renderer). Array order stays correct,
 * which is the property that is actually read.
 *
 * Returns the new message, or null when the chat has no live buffer.
 */
export function insertUserInterjectionMessage(
  chatId: number,
  content: string,
  /** The streaming assistant row to sit in front of. */
  placeholderMessageId: number,
  sessionRowId?: string,
): Message | null {
  const chat = ephemeralChats.get(chatId);
  if (!chat) return null;
  const msg: Message = {
    id: nextEphemeralMessageId(),
    chatId,
    role: "user",
    content,
    createdAt: new Date(),
    ...(sessionRowId ? { sessionRowId } : {}),
  };
  const at = chat.messages.findIndex((m) => m.id === placeholderMessageId);
  // A missing placeholder means the turn already finalized between the drain
  // and this call. Appending is then correct — it is the newest message.
  if (at < 0) chat.messages.push(msg);
  // Mutate in place: `updatedChat.messages` in the stream handler is the SAME
  // array (assigned across at turn start), and the chunk emitter copies from
  // it. Replacing the array here would leave the handler writing to the old one.
  else chat.messages.splice(at, 0, msg);
  return msg;
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

/**
 * The workspace chats this process holds, with how many messages each has and
 * its newest message id (ids grow with time, so the newest id is the most
 * recently active chat). For main-side delivery that picks a chat to wake.
 */
export function listStreamTransports(): Array<{
  chatId: number;
  appId: number | undefined;
  messageCount: number;
  lastMessageId: number;
}> {
  return [...ephemeralChats.values()].map((c) => ({
    chatId: c.id,
    appId: c.appId,
    messageCount: c.messages.length,
    lastMessageId: c.messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0),
  }));
}

/**
 * The session each of THIS process's transports is bound to.
 *
 * `chat_sessions.stream_chat_id` cannot say it: every Atlarix process numbers
 * its own transports, and the column holds whichever id the process that
 * opened the session LAST wrote. Read alone, it handed one session another's
 * transport: two CLIs in one folder both had -1, and `/resume X` in the second
 * reused its own -1, which was session Y's, so Y's pending approvals, job
 * results and queued messages landed in X (multi-process audit, 2026-10-20).
 */
const sessionByTransport = new Map<number, string>();

/** Record that this process bound `chatId` to `sessionId` (one transport per session). */
export function bindTransportToSession(chatId: number, sessionId: string): void {
  for (const [id, sid] of sessionByTransport) if (sid === sessionId && id !== chatId) sessionByTransport.delete(id);
  sessionByTransport.set(chatId, sessionId);
}

/** The session this process bound `chatId` to, if it did. */
export function sessionForTransport(chatId: number): string | undefined {
  return ephemeralChats.has(chatId) ? sessionByTransport.get(chatId) : undefined;
}

/** This process's live transport for `sessionId`, if it has one. */
export function transportForSession(sessionId: string): number | undefined {
  for (const [id, sid] of sessionByTransport) if (sid === sessionId && ephemeralChats.has(id)) return id;
  return undefined;
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
  // Any mid-turn message still waiting for this chat can never be delivered
  // once its buffer is gone — the queue is keyed on the same id and would
  // otherwise outlive the chat for the life of the main process. Imported
  // lazily: `user-interjections` is main-only and this module is imported from
  // the renderer's type graph.
  void import("@/lib/agent/user-interjections")
    .then((m) => m.clearUserInterjections(chatId))
    .catch(() => {});
  sessionByTransport.delete(chatId);
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
