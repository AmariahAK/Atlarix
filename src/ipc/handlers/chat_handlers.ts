import { ipcMain } from "electron";
import { db } from "../../db";
import { apps, chats, messages } from "../../db/schema";
import { desc, eq, and, like } from "drizzle-orm";
import type { ChatSearchResult, ChatSummary } from "../../lib/schemas";
import { createLoggedHandler } from "./safe_handle";
import {
  requireAuthSession,
  AuthRequiredError,
  formatAuthRequiredIpcError,
} from "../../lib/auth/require_auth_session";

import log from "electron-log";
import { getAtlarixAppPath } from "../../paths/paths";
import { UpdateChatParams } from "../ipc_types";
import { getCurrentCommitHash } from "../utils/git_utils";
import { clearAllSessionMemories } from "../../lib/session-memory";
import { clearInMemoryTaskLedgers } from "../../lib/tasks/task-ledger";
import { clearCompassContextWindow } from "../utils/token_utils";

const logger = log.scope("chat_handlers");
const handle = createLoggedHandler(logger);

export function registerChatHandlers() {
  // Create workspace chat - now uses EPHEMERAL storage (like incognito mode)
  // Chats are associated with workspace for context but NOT saved to database
  handle("create-chat", async (_, appId: number): Promise<number> => {
    try {
      await requireAuthSession();
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        throw new Error(formatAuthRequiredIpcError());
      }
      throw e;
    }
    // NOTE: Don't clear session memories here!
    // Session memory should persist across mode switches (Ask -> Build) within the same workspace
    // Memory is only cleared when explicitly switching to a different workspace

    // Verify the app exists
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

    // Create ephemeral workspace chat - NOT saved to database
    // This makes workspace chats "incognito" while maintaining workspace context
    clearInMemoryTaskLedgers();
    const { clearSessionLedger } = await import("@/lib/tasks/session-ledger");
    clearSessionLedger(appId);
    const { createEphemeralWorkspaceChat } = await import("./chat_only_handlers");
    const chatId = createEphemeralWorkspaceChat(appId);

    logger.info(
      "Created ephemeral workspace chat:",
      chatId,
      "for app:",
      appId,
      "(UI stream only; messages persist via workspace sessions)",
    );
    return chatId;
  });

  handle("create-chat-only", async (): Promise<number> => {
    try {
      await requireAuthSession();
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        throw new Error(formatAuthRequiredIpcError());
      }
      throw e;
    }
    clearAllSessionMemories();
    clearInMemoryTaskLedgers();
    const { createEphemeralChat } = await import("./chat_only_handlers");
    const chatId = createEphemeralChat();
    logger.info("Created ephemeral (incognito) chat-only session:", chatId);
    return chatId;
  });

  handle("chat:clear-ephemeral-messages", async (_, chatId: number) => {
    const { clearEphemeralChatMessages, isEphemeralChatId } = await import(
      "./chat_only_handlers"
    );
    if (!isEphemeralChatId(chatId)) return;
    clearEphemeralChatMessages(chatId);
  });

  handle(
    "chat:hydrate-ephemeral-messages",
    async (
      _,
      payload: {
        chatId: number;
        messages: { role: string; content: string; id?: number }[];
      },
    ) => {
      const { hydrateEphemeralChatMessages, isEphemeralChatId } = await import(
        "./chat_only_handlers"
      );
      if (!isEphemeralChatId(payload.chatId)) return;
      hydrateEphemeralChatMessages(payload.chatId, payload.messages ?? []);
    },
  );

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
        appId: ephemeralChat.appId ?? null,
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
    clearCompassContextWindow(chatId);
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
