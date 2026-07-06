import { randomUUID } from "node:crypto";
import log from "electron-log";
import { db } from "../../db";
import { chatSessions, sessionMessages } from "../../db/schema";
import { eq, desc, asc, sql, inArray, and } from "drizzle-orm";
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
import { requireAuthSession } from "@/lib/auth/require_auth_session";
import {
  createStreamTransport,
  deleteStreamTransport,
  getStreamTransport,
  getStreamTransportAppId,
  isStreamTransportId,
  seedEphemeralChatCounterBelow,
} from "@/lib/chat/stream-transport";

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
  /**
   * "interrupted" = cut off mid-stream (partial content, "Continue" affordance).
   * "waiting" = v14.7 turn parked on a human wait (approval / `ask_user`) — not an error.
   */
  status: "complete" | "interrupted" | "waiting";
  createdAt: Date;
  displaySnapshot?: DisplaySnapshotV1 | null;
  modelContent?: string | null;
  pasteAttachments?: PasteAttachmentMeta[] | null;
  fileAttachments?: StoredFileAttachment[] | null;
  /** Shadow-git revert checkpoint id; lets revert-turn survive a restart. */
  snapshotTurnId?: string | null;
};

export type SessionMessageExtras = {
  modelContent?: string | null;
  pasteAttachments?: PasteAttachmentMeta[] | null;
  fileAttachments?: StoredFileAttachment[] | null;
  snapshotTurnId?: string | null;
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
    status: (row.status ?? "complete") as SessionMessageRow["status"],
    createdAt: row.createdAt,
    displaySnapshot: parseDisplaySnapshot(row.displaySnapshot),
    modelContent: row.modelContent ?? null,
    pasteAttachments: row.pasteAttachments ?? null,
    fileAttachments: row.fileAttachments ?? null,
    snapshotTurnId: row.snapshotTurnId ?? null,
  };
}

/**
 * Persist a user-message edit by DIRECT row id — every persisted message
 * carries `sessionRowId` (set at persist time, threaded through hydration;
 * since 0.4-C3 the ask_user Q→A insert carries it too). Updates the row's
 * content and deletes every row after it (chronological order). The old
 * ordinal mapping (and its 3.3 window-boundary failure class) was DELETED
 * in 0.4-C3 — this is the only edit-persistence path.
 */
export async function persistEditedSessionMessageById(
  sessionRowId: string,
  newContent: string,
  /**
   * W2 (v14.8.11): regenerated model-facing content for the edited row
   * (edited prose with attachment stubs re-expanded). Always written —
   * leaving the column untouched would keep the PRE-edit prose, which
   * dispatch prefers over `content`, silently undoing the user's edit for
   * the model after a reload. Null when the edited message has no model
   * variant.
   */
  newModelContent?: string | null,
): Promise<"updated" | "not_found"> {
  const target = await db.query.sessionMessages.findFirst({
    where: eq(sessionMessages.id, sessionRowId),
  });
  if (!target) return "not_found";

  const allRows = await db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, target.sessionId))
    .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
  const targetPos = allRows.findIndex((r) => r.id === sessionRowId);
  const deleteIds = allRows.slice(targetPos + 1).map((r) => r.id);

  await db
    .update(sessionMessages)
    .set({ content: newContent, modelContent: newModelContent ?? null })
    .where(eq(sessionMessages.id, sessionRowId));
  if (deleteIds.length > 0) {
    await db
      .delete(sessionMessages)
      .where(inArray(sessionMessages.id, deleteIds));
  }
  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatSessions.id, target.sessionId));
  return "updated";
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

/**
 * Main-side session-message insert. The `messages:add` IPC handler delegates
 * here; background agents (v12 2.3) call it directly because there is no
 * renderer to fire `messages:add` on `chat:response:end`.
 */
export async function addSessionMessageDirect(
  sessionId: string,
  role: "user" | "assistant" | "tool",
  content: string,
  displaySnapshot?: string,
  extras?: SessionMessageExtras,
): Promise<SessionMessageRow> {
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
      snapshotTurnId: extras?.snapshotTurnId ?? null,
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
 * Crash-safe partial-output persistence. While an assistant turn streams, the
 * main process upserts the accumulated text into a single "interrupted" row per
 * stream (see `partialDraftRowByChatId` in chat_stream_handlers). If the app is
 * killed / suspended / the stream is aborted, that row survives and the session
 * renders it with a Continue affordance. On clean completion the draft is
 * deleted — the renderer persists the authoritative finished message instead.
 */
export async function upsertInterruptedAssistantDraft(
  existingRowId: string | null,
  sessionId: string,
  content: string,
): Promise<string> {
  const now = new Date();
  if (existingRowId) {
    await db
      .update(sessionMessages)
      .set({ content, status: "interrupted" })
      .where(eq(sessionMessages.id, existingRowId));
    await db
      .update(chatSessions)
      .set({ updatedAt: now })
      .where(eq(chatSessions.id, sessionId));
    return existingRowId;
  }
  const id = randomUUID();
  await db.insert(sessionMessages).values({
    id,
    sessionId,
    role: "assistant",
    content,
    status: "interrupted",
    createdAt: now,
  });
  await db
    .update(chatSessions)
    .set({ updatedAt: now })
    .where(eq(chatSessions.id, sessionId));
  await trimSessionMessagesIfNeeded(sessionId);
  return id;
}

/** Remove an interrupted draft row once the turn completes (or is superseded). */
export async function deleteInterruptedAssistantDraft(rowId: string): Promise<void> {
  await db.delete(sessionMessages).where(eq(sessionMessages.id, rowId));
}

/** Promote an interrupted row to a normal history message (used by "Continue"). */
export async function markSessionMessageComplete(rowId: string): Promise<void> {
  await db
    .update(sessionMessages)
    .set({ status: "complete" })
    .where(eq(sessionMessages.id, rowId));
}

/**
 * v14.7: mark an assistant row as PARKED on a human wait (pending approval /
 * `ask_user`) — distinct from "interrupted" so reopen renders the wait/question
 * affordance, not the error/Continue UI.
 */
export async function markSessionMessageWaiting(rowId: string): Promise<void> {
  await db
    .update(sessionMessages)
    .set({ status: "waiting" })
    .where(eq(sessionMessages.id, rowId));
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

  if (!isStreamTransportId(input.chatId)) {
    throw new Error("workspaceSessionId is required for workspace chat streams");
  }

  const byTransport = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.streamChatId, input.chatId),
  });
  if (byTransport) return byTransport.id;

  const appId =
    input.workspaceAppId ?? getStreamTransportAppId(input.chatId);
  if (appId == null || !getStreamTransport(input.chatId)) {
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
      (isStreamTransportId(stored) && !getStreamTransport(stored))
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
/**
 * Pure reuse/prune decision for workspace open / New chat (v10.1):
 * given the workspace's sessions (most-recent first) with message counts,
 * pick the newest default-titled EMPTY session to reuse and mark the other
 * empties for deletion. Sessions with messages or custom titles are never
 * touched. Extracted for unit testing.
 */
export function pickSessionReuse(
  rows: { id: string; title: string; messageCount: number }[],
): { reuseId: string | null; pruneIds: string[] } {
  const empties = rows.filter(
    (r) => Number(r.messageCount) === 0 && DEFAULT_SESSION_TITLES.has(r.title),
  );
  if (empties.length === 0) return { reuseId: null, pruneIds: [] };
  return {
    reuseId: empties[0].id,
    pruneIds: empties.slice(1).map((r) => r.id),
  };
}

/** Sessions for this workspace (most recent first) with their message counts. */
async function listSessionsWithMessageCounts(
  workspaceId: number,
): Promise<{ id: string; title: string; messageCount: number }[]> {
  return db
    .select({
      id: chatSessions.id,
      title: chatSessions.title,
      messageCount: sql<number>`(
        select count(*) from ${sessionMessages}
        where ${sessionMessages.sessionId} = ${chatSessions.id}
      )`,
    })
    .from(chatSessions)
    .where(eq(chatSessions.workspaceId, workspaceId))
    .orderBy(desc(chatSessions.updatedAt));
}

/**
 * Startup: seed the ephemeral transport counter below the most-negative
 * persisted `streamChatId` so newly created transports can never collide with a
 * persisted session's id (which would make `allocateSessionTransport` reuse one
 * live transport for two sessions — the cross-session pending-question leak).
 * Best-effort; safe to call before any transport is created.
 */
export async function seedEphemeralCounterFromSessions(): Promise<void> {
  try {
    const [row] = await db
      .select({ min: sql<number | null>`min(${chatSessions.streamChatId})` })
      .from(chatSessions);
    const min = row?.min;
    if (typeof min === "number" && min < 0) {
      seedEphemeralChatCounterBelow(min);
    }
  } catch (e) {
    logger.warn("seedEphemeralCounterFromSessions failed (non-fatal)", e);
  }
}

export async function startWorkspaceSession(workspaceId: number): Promise<{
  sessionId: string;
  chatId: number;
  session: ChatSessionRow;
}> {
  // v10.1 fix: every app reopen created a fresh "Untitled" session, cluttering
  // the sidebar with empties. Reuse the most recent session when it's still
  // default-titled with zero messages, and prune any other stale empties.
  let session: ChatSessionRow | null = null;
  try {
    const rows = await listSessionsWithMessageCounts(workspaceId);
    const { reuseId, pruneIds } = pickSessionReuse(rows);
    if (reuseId) {
      const [reuse] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, reuseId));
      if (reuse) {
        session = mapSession(reuse);
        logger.log(
          `Reusing empty session ${session.id} for workspace ${workspaceId}`,
        );
      }
    }
    if (pruneIds.length > 0) {
      await db.delete(chatSessions).where(inArray(chatSessions.id, pruneIds));
      logger.log(
        `Pruned ${pruneIds.length} stale empty session(s) for workspace ${workspaceId}`,
      );
    }
  } catch (e) {
    logger.warn("Empty-session reuse check failed; creating a new session:", e);
  }

  if (!session) {
    session = await insertWorkspaceSession(workspaceId);
  }
  const chatId = createStreamTransport(workspaceId);
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
      .where(
        and(
          eq(chatSessions.workspaceId, workspaceId),
          // Automation-run transcripts (kind="background") live in the
          // automations feed, not the workspace session list.
          eq(chatSessions.kind, "normal"),
        ),
      )
      .orderBy(desc(chatSessions.updatedAt));
    return rows.map((r) => mapSession(r));
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

  handle(
    "sessions:snapshot-turn-ids",
    async (_event, payload: { chatId: number }) => {
      // Bug 6: rehydrate the revert-turn affordance on ANY load path (relaunch /
      // openWorkspaceFolder), not just manual session-list selection. Resolve the
      // chat's bound session READ-ONLY (no binding side effects), then return the
      // persisted per-assistant snapshot_turn_id rows so the renderer can rebuild
      // turnSnapshotTurnIdByMessageId via buildRevertSnapshotMap. Cheap targeted
      // query — not a full session message load.
      const session = await db.query.chatSessions.findFirst({
        where: eq(chatSessions.streamChatId, payload.chatId),
      });
      if (!session) return [];
      const rows = await db
        .select({
          id: sessionMessages.id,
          snapshotTurnId: sessionMessages.snapshotTurnId,
        })
        .from(sessionMessages)
        .where(
          and(
            eq(sessionMessages.sessionId, session.id),
            eq(sessionMessages.role, "assistant"),
          ),
        )
        .all();
      const out = rows
        .filter((r) => !!r.snapshotTurnId)
        .map((r) => ({ rowId: r.id, snapshotTurnId: r.snapshotTurnId as string }));
      if (process.env.ATLARIX_DIAG_146 === "1") {
        logger.info(
          `[DIAG_146] snapshot-turn-ids chat=${payload.chatId} session=${session.id} assistantRows=${rows.length} withSnapshot=${out.length}`,
        );
      }
      return out;
    },
  );

  handle("sessions:start", async (_event, workspaceId: number) => {
    // Defense-in-depth: a workspace session may only be started by a signed-in
    // user (the UI gates selection too, but never trust the renderer).
    await requireAuthSession();
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
      isStreamTransportId(stored) &&
      getStreamTransport(stored)?.appId === session.workspaceId
    ) {
      return { chatId: stored };
    }

    const chatId = createStreamTransport(session.workspaceId);
    await persistSessionStreamChatId(sessionId, chatId);
    return { chatId };
  });

  handle("sessions:create", async (_event, workspaceId: number) => {
    await requireAuthSession();
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
    // v12 (TODO 2.4): prune the in-memory transport state too — the DB delete
    // alone leaked the ephemeral chat, partial responses, last stream request
    // and ask_user state for every deleted session.
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));

    const streamChatId = session?.streamChatId ?? null;
    if (streamChatId != null && isStreamTransportId(streamChatId)) {
      deleteStreamTransport(streamChatId);
      const { clearChatStreamStateForChat } = await import(
        "./chat_stream_handlers"
      );
      clearChatStreamStateForChat(streamChatId);
    }

    // Returned so the renderer can clear its per-chat atoms for this transport.
    return { ok: true, streamChatId };
  });

  handle(
    "sessions:get",
    async (
      _event,
      sessionId: string,
      opts?: { limit?: number },
    ) => {
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
      const rows = [...recent].reverse();

      const messages = rows
        .map(mapMessage)
        .filter((m) => m.kind !== "plan");
      hydrateAttachmentStoreFromMessages(
        messages,
        typeof session.streamChatId === "number" ? session.streamChatId : undefined,
        session.id,
      );
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
    ) => addSessionMessageDirect(sessionId, role, content, displaySnapshot, extras),
  );

  handle("messages:mark-complete", async (_event, rowId: string) => {
    await markSessionMessageComplete(rowId);
    return { ok: true };
  });

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
