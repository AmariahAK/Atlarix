import { ipcMain } from "electron";
import { db } from "../../db";
import { apps, chats, messages } from "../../db/schema";
import { desc, eq, and, like } from "drizzle-orm";
import type { ChatSearchResult, ChatSummary } from "../../lib/schemas";
import { createLoggedHandler } from "./safe_handle";

import log from "electron-log";
import { getAtlarixAppPath } from "../../paths/paths";
import { UpdateChatParams } from "../ipc_types";
import { getCurrentCommitHash } from "../utils/git_utils";

const logger = log.scope("chat_handlers");
const handle = createLoggedHandler(logger);

export function registerChatHandlers() {
  handle("create-chat", async (_, appId: number): Promise<number> => {
    // Get the app's path first
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
      columns: {
        path: true,
        name: true,
      },
    });

    if (!app) {
      throw new Error("App not found");
    }

    let initialCommitHash = null;
    try {
      // Get the current git revision of main branch
      initialCommitHash = await getCurrentCommitHash({
        path: getAtlarixAppPath(app.path),
        ref: "main",
      });
    } catch (error) {
      logger.error("Error getting git revision:", error);
      // Continue without the git revision
    }

    // Create a new chat with null title (will be named on first message)
    // and lastUsedAt timestamp
    const now = new Date();
    const [chat] = await db
      .insert(chats)
      .values({
        appId,
        initialCommitHash,
        title: null, // Will be set with keyword-based name on first message
        lastUsedAt: now,
      })
      .returning();
    logger.info(
      "Created chat:",
      chat.id,
      "for app:",
      appId,
      "with initial commit hash:",
      initialCommitHash,
    );
    return chat.id;
  });

  // Create chat-only session (ephemeral/incognito - NOT saved to DB)
  handle("create-chat-only", async (): Promise<number> => {
    // Import ephemeral chat creator from chat_only_handlers
    const { createEphemeralChat } = await import("./chat_only_handlers");
    const chatId = createEphemeralChat();
    logger.info("Created ephemeral (incognito) chat-only session:", chatId);
    return chatId;
  });

  ipcMain.handle("get-chat", async (_, chatId: number) => {
    // Check if this is an ephemeral (incognito) chat (negative ID)
    const { getEphemeralChat, isEphemeralChatId } = await import("./chat_only_handlers");

    if (isEphemeralChatId(chatId)) {
      const ephemeralChat = getEphemeralChat(chatId);
      if (!ephemeralChat) {
        throw new Error("Ephemeral chat not found");
      }
      return {
        id: ephemeralChat.id,
        title: ephemeralChat.title,
        messages: ephemeralChat.messages,
        createdAt: ephemeralChat.createdAt,
        appId: null,
      };
    }

    // Regular database chat
    // Update last_used_at timestamp when chat is opened
    await db.update(chats).set({ lastUsedAt: new Date() }).where(eq(chats.id, chatId));

    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, chatId),
      with: {
        messages: {
          orderBy: (messages, { asc }) => [asc(messages.createdAt)],
        },
      },
    });

    if (!chat) {
      throw new Error("Chat not found");
    }

    return chat;
  });

  handle("get-chats", async (_, appId?: number): Promise<ChatSummary[]> => {
    // If appId is provided, filter chats for that app
    const query = appId
      ? db.query.chats.findMany({
        where: eq(chats.appId, appId),
        columns: {
          id: true,
          title: true,
          createdAt: true,
          appId: true,
        },
        orderBy: [desc(chats.createdAt)],
      })
      : db.query.chats.findMany({
        columns: {
          id: true,
          title: true,
          createdAt: true,
          appId: true,
        },
        orderBy: [desc(chats.createdAt)],
      });

    const allChats = await query;
    return allChats;
  });

  handle("delete-chat", async (_, chatId: number): Promise<void> => {
    await db.delete(chats).where(eq(chats.id, chatId));
  });

  handle("update-chat", async (_, { chatId, title }: UpdateChatParams) => {
    await db.update(chats).set({ title }).where(eq(chats.id, chatId));
  });

  handle("delete-messages", async (_, chatId: number): Promise<void> => {
    await db.delete(messages).where(eq(messages.chatId, chatId));
  });

  handle(
    "search-chats",
    async (_, appId: number, query: string): Promise<ChatSearchResult[]> => {
      // 1) Find chats by title and map to ChatSearchResult with no matched message
      const chatTitleMatches = await db
        .select({
          id: chats.id,
          appId: chats.appId,
          title: chats.title,
          createdAt: chats.createdAt,
        })
        .from(chats)
        .where(and(eq(chats.appId, appId), like(chats.title, `%${query}%`)))
        .orderBy(desc(chats.createdAt))
        .limit(10);

      const titleResults: ChatSearchResult[] = chatTitleMatches.map((c) => ({
        id: c.id,
        appId: c.appId,
        title: c.title,
        createdAt: c.createdAt,
        matchedMessageContent: null,
      }));

      // 2) Find messages that match and join to chats to build one result per message
      const messageResults = await db
        .select({
          id: chats.id,
          appId: chats.appId,
          title: chats.title,
          createdAt: chats.createdAt,
          matchedMessageContent: messages.content,
        })
        .from(messages)
        .innerJoin(chats, eq(messages.chatId, chats.id))
        .where(
          and(eq(chats.appId, appId), like(messages.content, `%${query}%`)),
        )
        .orderBy(desc(chats.createdAt))
        .limit(10);

      // Combine: keep title matches and per-message matches
      const combined: ChatSearchResult[] = [...titleResults, ...messageResults];
      const uniqueChats = Array.from(
        new Map(combined.map((item) => [item.id, item])).values(),
      );

      // Sort newest chats first
      uniqueChats.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      return uniqueChats;
    },
  );
}
