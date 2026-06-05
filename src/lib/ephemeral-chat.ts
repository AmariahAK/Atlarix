/**
 * Ephemeral workspace chat transport (negative chatId, in-memory messages).
 * Not for global/incognito chat — workspace context required for streaming.
 */

import log from "electron-log";
import type { Message } from "@/ipc/ipc_types";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";
import { rebuildSessionMemoryFromMessages } from "@/lib/session-memory";

const logger = log.scope("ephemeral-chat");

export function buildContinueAfterQuestionsPrompt(
  msgs: { role: string; content?: string | null }[],
): string {
  const userMsgs = msgs.filter((m) => m.role === "user");
  if (userMsgs.length === 0) return "";
  if (userMsgs.length === 1) return String(userMsgs[0].content ?? "").trim();
  const a = String(userMsgs[userMsgs.length - 2]?.content ?? "").trim();
  const b = String(userMsgs[userMsgs.length - 1]?.content ?? "").trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n---\n\n${b}`;
}

export function insertAskUserAnswerUserMessage(
  chatId: number,
  formattedContent: string,
): boolean {
  const chat = ephemeralChats.get(chatId);
  if (!chat) return false;
  const msg: Message = {
    id: Date.now(),
    chatId,
    role: "user",
    content: formattedContent,
    createdAt: new Date(),
  };
  chat.messages.push(msg);
  return true;
}

export function editEphemeralUserMessage(
  chatId: number,
  userMessageId: number,
  newContent: string,
): boolean {
  const chat = ephemeralChats.get(chatId);
  if (!chat) return false;
  const idx = chat.messages.findIndex(
    (m) => m.id === userMessageId && m.role === "user",
  );
  if (idx < 0) return false;
  const prev = chat.messages[idx];
  chat.messages[idx] = { ...prev, content: newContent };
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

export function createEphemeralWorkspaceChat(appId: number): number {
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

export function getEphemeralChatAppId(chatId: number): number | undefined {
  return ephemeralChats.get(chatId)?.appId;
}

export function getEphemeralChat(chatId: number) {
  return ephemeralChats.get(chatId);
}

export function isEphemeralChatId(chatId: number): boolean {
  return chatId < 0;
}

/**
 * v12 (TODO 2.4): drop the in-memory chat entirely when its session is
 * deleted — entries were never pruned, leaking message arrays per deleted
 * session for the lifetime of the main process.
 */
export function deleteEphemeralChat(chatId: number): boolean {
  return ephemeralChats.delete(chatId);
}

export function clearEphemeralChatMessages(chatId: number): void {
  const chat = ephemeralChats.get(chatId);
  if (!chat) return;
  chat.messages = [];
  ephemeralChats.set(chatId, chat);
}

export function setEphemeralMessageDisplaySnapshot(
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

export function hydrateEphemeralChatMessages(
  chatId: number,
  messages: {
    role: string;
    content: string;
    id?: number;
    displaySnapshot?: DisplaySnapshotV1 | null;
    modelContent?: string | null;
    pasteAttachments?: import("@/ipc/ipc_types").PasteAttachmentMeta[] | null;
    fileAttachments?: import("@/ipc/ipc_types").StoredFileAttachment[] | null;
    attachments?: import("@/ipc/ipc_types").AttachmentInfo[] | null;
  }[],
): void {
  const chat = ephemeralChats.get(chatId);
  if (!chat) return;
  let seq = 0;
  chat.messages = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id:
        typeof m.id === "number" && Number.isFinite(m.id)
          ? m.id
          : Date.now() + seq++,
      chatId,
      role: m.role as "user" | "assistant",
      content: m.content ?? "",
      createdAt: new Date(),
      ...(m.modelContent ? { modelContent: m.modelContent } : {}),
      ...(m.pasteAttachments?.length
        ? { pasteAttachments: m.pasteAttachments }
        : {}),
      ...(m.fileAttachments?.length
        ? { fileAttachments: m.fileAttachments }
        : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.displaySnapshot ? { displaySnapshot: m.displaySnapshot } : {}),
    }));
  ephemeralChats.set(chatId, chat);
  if (chat.appId != null) {
    rebuildSessionMemoryFromMessages(chat.appId, messages);
  }
}

export function addEphemeralMessage(
  chatId: number,
  message: {
    role: string;
    content: string;
    autoRoutedTier?: "fast" | "balanced" | "thinking";
  },
): void {
  const chat = ephemeralChats.get(chatId);
  if (chat) {
    chat.messages.push({
      ...message,
      id: Date.now(),
      chatId,
      createdAt: new Date(),
    } as Message);
  }
}

