import { randomUUID } from "node:crypto";
import log from "electron-log";
import { db } from "../../db";
import { chatSessions, sessionMessages } from "../../db/schema";
import { eq, desc, asc, sql, inArray } from "drizzle-orm";
import { createLoggedHandler } from "./safe_handle";
import {
  SESSION_LOAD_MESSAGE_LIMIT,
  SESSION_STORE_MESSAGE_MAX,
} from "@/constants/session_constants";
import {
  generateAIChatName,
  generateSimpleChatName,
  isLowQualityGeneratedTitle,
  stripContentForTitleSource,
} from "../../utils/chat_naming";
import {
  parseDisplaySnapshot,
  type DisplaySnapshotV1,
} from "@/lib/chat/display-snapshot";
import type {
  PasteAttachmentMeta,
  StoredFileAttachment,
} from "../ipc_types";
import { hydrateAttachmentStoreFromMessages } from "@/lib/attachment-persistence";
import {
  createEphemeralWorkspaceChat,
  getEphemeralChat,
  getEphemeralChatAppId,
  isEphemeralChatId,
} from "@/lib/ephemeral-chat";

const DEFAULT_SESSION_TITLES = new Set(["Untitled", "New session", "New chat"]);
const logger = log.scope("workspace_session_handlers");
const handle = createLoggedHandler(logger);

export type ChatSessionRow = {
  id: string;
  workspaceId: number;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionMessageRow = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  kind: "message" | "plan";
  createdAt: Date;
  displaySnapshot?: DisplaySnapshotV1 | null;
  modelContent?: string | null;
  pasteAttachments?: PasteAttachmentMeta[] | null;
  fileAttachments?: StoredFileAttachment[] | null;
};

export type SessionMessageExtras = {
  modelContent?: string | null;
  pasteAttachments?: PasteAttachmentMeta[] | null;
  fileAttachments?: StoredFileAttachment[] | null;
};

function mapSession(row: typeof chatSessions.$inferSelect): ChatSessionRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMessage(row: typeof sessionMessages.$inferSelect): SessionMessageRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as SessionMessageRow["role"],
    content: row.content,
    kind: (row.kind ?? "message") as SessionMessageRow["kind"],
    createdAt: row.createdAt,
    displaySnapshot: parseDisplaySnapshot(row.displaySnapshot),
    modelContent: row.modelContent ?? null,
    pasteAttachments: row.pasteAttachments ?? null,
    fileAttachments: row.fileAttachments ?? null,
  };
}

/**
 * Pure ordinal mapping for a session edit: given the session's full row list in
 * chronological order, locate the DB row for the ephemeral message at `ephIdx`
 * (among visible user/assistant, non-plan rows, offset by the load window) and
 * the tail rows to delete. Extracted for unit testing.
 */
export function computeSessionEditTarget(
  allRows: { id: string; role: string; kind: string | null }[],
  ephIdx: number,
  ephCount: number,
): { targetId: string; deleteIds: string[] } | null {
  if (ephIdx < 0) return null;
  const visible = allRows.filter(
    (r) => (r.role === "user" || r.role === "assistant") && r.kind !== "plan",
  );
  const dbOrdinal = visible.length - ephCount + ephIdx;
  if (dbOrdinal < 0 || dbOrdinal >= visible.length) return null;
  const target = visible[dbOrdinal]!;
  const targetPos = allRows.findIndex((r) => r.id === target.id);
  const deleteIds = allRows.slice(targetPos + 1).map((r) => r.id);
  return { targetId: target.id, deleteIds };
}

/**
 * Persist a user-message edit to the saved session: update the edited row's
 * content and delete the (regenerated) tail after it. Maps the in-memory
 * ephemeral message to its DB row by ordinal (ids don't correlate across the
 * ephemeral/persisted stores), accounting for the SESSION_LOAD_MESSAGE_LIMIT
 * load offset.
 *
 * @param chatId   numeric ephemeral/stream chat id (chatSessions.streamChatId)
 * @param ephIdx   index of the edited message among ephemeral messages (pre-truncation)
 * @param ephCount total ephemeral message count (pre-truncation)
 */
export async function persistEditedSessionMessage(
  chatId: number,
  ephIdx: number,
  ephCount: number,
  newContent: string,
): Promise<void> {
  if (ephIdx < 0) return;
  const session = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.streamChatId, chatId),
  });
  if (!session) return; // not a persisted workspace session — nothing to update

  const allRows = await db
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, session.id))
    .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));

  const target = computeSessionEditTarget(allRows, ephIdx, ephCount);
  if (!target) return; // can't map (offset edge) — leave the DB untouched

  await db
    .update(sessionMessages)
    .set({ content: newContent })
    .where(eq(sessionMessages.id, target.targetId));

  if (target.deleteIds.length > 0) {
    await db
      .delete(sessionMessages)
      .where(inArray(sessionMessages.id, target.deleteIds));
  }

  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatSessions.id, session.id));
}

async function trimSessionMessagesIfNeeded(sessionId: string): Promise<void> {
  const rows = await db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(asc(sessionMessages.createdAt));

  if (rows.length > SESSION_STORE_MESSAGE_MAX) {
    const excess = rows.length - SESSION_STORE_MESSAGE_MAX;
    const idsToDelete = rows.slice(0, excess).map((r) => r.id);
    await db
      .delete(sessionMessages)
      .where(inArray(sessionMessages.id, idsToDelete));
  }
}

export async function persistWorkspaceSessionUserMessage(
  sessionId: string,
  content: string,
  extras?: SessionMessageExtras,
): Promise<SessionMessageRow> {
  const now = new Date();
  const id = randomUUID();
  const [message] = await db
    .insert(sessionMessages)
    .values({
      id,
      sessionId,
      role: "user",
      content,
      modelContent: extras?.modelContent ?? null,
      pasteAttachments: extras?.pasteAttachments ?? null,
      fileAttachments: extras?.fileAttachments ?? null,
      createdAt: now,
    })
    .returning();
  await db
    .update(chatSessions)
    .set({ updatedAt: now })
    .where(eq(chatSessions.id, sessionId));
  await trimSessionMessagesIfNeeded(sessionId);
  return mapMessage(message);
}

/**
 * Resolve workspace session id for an ephemeral transport chat.
 * Uses DB stream_chat_id, then binds an unmapped transport to the latest session for the workspace.
 */
export async function resolveOrBindWorkspaceSessionForStream(input: {
  workspaceSessionId?: string | null;
  chatId: number;
  workspaceAppId?: number | null;
}): Promise<string> {
  const provided = input.workspaceSessionId?.trim();
  if (provided) return provided;

  if (!isEphemeralChatId(input.chatId)) {
    throw new Error("workspaceSessionId is required for workspace chat streams");
  }

  const byTransport = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.streamChatId, input.chatId),
  });
  if (byTransport) return byTransport.id;

  const appId =
    input.workspaceAppId ?? getEphemeralChatAppId(input.chatId);
  if (appId == null || !getEphemeralChat(input.chatId)) {
    throw new Error("workspaceSessionId is required for workspace chat streams");
  }

  const latest = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.workspaceId, appId),
    orderBy: [desc(chatSessions.updatedAt)],
  });

  if (latest) {
    const stored = latest.streamChatId;
    if (
      stored == null ||
      (isEphemeralChatId(stored) && !getEphemeralChat(stored))
    ) {
      await persistSessionStreamChatId(latest.id, input.chatId);
      logger.warn(
        `Bound transport chat ${input.chatId} to session ${latest.id} (workspace ${appId})`,
      );
      return latest.id;
    }
  }

  const session = await insertWorkspaceSession(appId);
  await persistSessionStreamChatId(session.id, input.chatId);
  logger.info(
    `Created session ${session.id} for transport chat ${input.chatId} (workspace ${appId})`,
  );
  return session.id;
}

/** Create session row + ephemeral transport (shared by IPC and import). */
export async function startWorkspaceSession(workspaceId: number): Promise<{
  sessionId: string;
  chatId: number;
  session: ChatSessionRow;
}> {
  const session = await insertWorkspaceSession(workspaceId);
  const chatId = createEphemeralWorkspaceChat(workspaceId);
  await persistSessionStreamChatId(session.id, chatId);
  return { sessionId: session.id, chatId, session };
}

async function insertWorkspaceSession(
  workspaceId: number,
): Promise<ChatSessionRow> {
  const now = new Date();
  const id = randomUUID();
  const [row] = await db
    .insert(chatSessions)
    .values({
      id,
      workspaceId,
      title: "Untitled",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapSession(row);
}

/** Bind in-memory stream transport to a persisted session (optional column). */
async function persistSessionStreamChatId(
  sessionId: string,
  chatId: number,
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ streamChatId: chatId, updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

export function registerWorkspaceSessionHandlers(): void {
  handle("sessions:list", async (_event, workspaceId: number) => {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.workspaceId, workspaceId))
      .orderBy(desc(chatSessions.updatedAt));
    return rows.map(mapSession);
  });

  handle(
    "sessions:resolve-for-transport",
    async (
      _event,
      payload: { chatId: number; workspaceId?: number },
    ) => {
      return resolveOrBindWorkspaceSessionForStream({
        chatId: payload.chatId,
        workspaceAppId: payload.workspaceId,
      });
    },
  );

  handle("sessions:start", async (_event, workspaceId: number) => {
    const started = await startWorkspaceSession(workspaceId);
    logger.info(
      `sessions:start workspace=${workspaceId} session=${started.sessionId} transport=${started.chatId}`,
    );
    return started;
  });

  handle("sessions:allocate-transport", async (_event, sessionId: string) => {
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session) throw new Error("Session not found");

    const stored = session.streamChatId;
    if (
      stored != null &&
      isEphemeralChatId(stored) &&
      getEphemeralChat(stored)?.appId === session.workspaceId
    ) {
      return { chatId: stored };
    }

    const chatId = createEphemeralWorkspaceChat(session.workspaceId);
    await persistSessionStreamChatId(sessionId, chatId);
    return { chatId };
  });

  handle("sessions:create", async (_event, workspaceId: number) => {
    return insertWorkspaceSession(workspaceId);
  });

  handle(
    "sessions:rename",
    async (_event, sessionId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) {
        throw new Error("Title cannot be empty");
      }
      const [row] = await db
        .update(chatSessions)
        .set({ title: trimmed, updatedAt: new Date() })
        .where(eq(chatSessions.id, sessionId))
        .returning();
      if (!row) throw new Error("Session not found");
      return mapSession(row);
    },
  );

  handle("sessions:delete", async (_event, sessionId: string) => {
    await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
    return { ok: true };
  });

  handle(
    "sessions:get",
    async (_event, sessionId: string, opts?: { limit?: number }) => {
      const session = await db.query.chatSessions.findFirst({
        where: eq(chatSessions.id, sessionId),
      });
      if (!session) throw new Error("Session not found");

      const limit = opts?.limit ?? SESSION_LOAD_MESSAGE_LIMIT;
      const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sessionId));
      const totalCount = Number(countRow?.count ?? 0);

      const recent = await db
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sessionId))
        .orderBy(desc(sessionMessages.createdAt))
        .limit(limit);

      const messages = [...recent]
        .reverse()
        .map(mapMessage)
        .filter((m) => m.kind !== "plan");
      hydrateAttachmentStoreFromMessages(messages);
      return {
        session: mapSession(session),
        messages,
        truncated: totalCount > limit,
        totalCount,
      };
    },
  );

  handle(
    "messages:add",
    async (
      _event,
      sessionId: string,
      role: "user" | "assistant" | "tool",
      content: string,
      displaySnapshot?: string,
      extras?: SessionMessageExtras,
    ) => {
      if (!["user", "assistant", "tool"].includes(role)) {
        throw new Error(`Invalid message role: ${role}`);
      }
      if (displaySnapshot != null && !parseDisplaySnapshot(displaySnapshot)) {
        throw new Error("Invalid display snapshot payload");
      }
      const now = new Date();
      const id = randomUUID();
      const [message] = await db
        .insert(sessionMessages)
        .values({
          id,
          sessionId,
          role,
          content,
          displaySnapshot: displaySnapshot ?? null,
          modelContent: extras?.modelContent ?? null,
          pasteAttachments: extras?.pasteAttachments ?? null,
          fileAttachments: extras?.fileAttachments ?? null,
          createdAt: now,
        })
        .returning();
      await db
        .update(chatSessions)
        .set({ updatedAt: now })
        .where(eq(chatSessions.id, sessionId));

      await trimSessionMessagesIfNeeded(sessionId);

      return mapMessage(message);
    },
  );

  handle("sessions:generate-title", async (_event, sessionId: string) => {
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session) throw new Error("Session not found");

    const currentTitle = session.title.trim();
    if (!DEFAULT_SESSION_TITLES.has(currentTitle)) {
      return { title: currentTitle };
    }

    const rows = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(asc(sessionMessages.createdAt));

    const firstUser = rows.find((m) => m.role === "user");
    const firstAssistant = rows.find((m) => m.role === "assistant");
    if (!firstUser?.content?.trim() || !firstAssistant?.content?.trim()) {
      return { title: currentTitle };
    }

    const conversationMessages = [
      {
        role: "user",
        content: stripContentForTitleSource(firstUser.content, "user"),
      },
      {
        role: "assistant",
        content: stripContentForTitleSource(firstAssistant.content, "assistant").slice(
          0,
          2000,
        ),
      },
    ];

    let newTitle = currentTitle;
    try {
      newTitle = await generateAIChatName(conversationMessages, currentTitle);
    } catch (err) {
      logger.warn("AI session title generation failed:", err);
      const summaryMatch = firstAssistant.content.match(
        /<atlarix-chat-summary>([\s\S]*?)<\/atlarix-chat-summary>/,
      );
      if (summaryMatch?.[1]?.trim()) {
        newTitle = summaryMatch[1].trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 80);
      }
    }

    const trimmed = newTitle.trim();
    if (
      isLowQualityGeneratedTitle(trimmed) &&
      conversationMessages[0]?.content?.trim()
    ) {
      newTitle = generateSimpleChatName(conversationMessages[0].content);
    }

    const finalTitle = newTitle.trim();
    if (
      finalTitle &&
      DEFAULT_SESSION_TITLES.has(currentTitle) &&
      !DEFAULT_SESSION_TITLES.has(finalTitle) &&
      !isLowQualityGeneratedTitle(finalTitle)
    ) {
      await db
        .update(chatSessions)
        .set({ title: finalTitle, updatedAt: new Date() })
        .where(eq(chatSessions.id, sessionId));
      return { title: finalTitle };
    }

    return { title: currentTitle };
  });
}
