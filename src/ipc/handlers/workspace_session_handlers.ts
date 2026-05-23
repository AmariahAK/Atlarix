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
  createdAt: Date;
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
    createdAt: row.createdAt,
  };
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

  handle("sessions:create", async (_event, workspaceId: number) => {
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

      const messages = [...recent].reverse().map(mapMessage);
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
    ) => {
      if (!["user", "assistant", "tool"].includes(role)) {
        throw new Error(`Invalid message role: ${role}`);
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
          createdAt: now,
        })
        .returning();
      await db
        .update(chatSessions)
        .set({ updatedAt: now })
        .where(eq(chatSessions.id, sessionId));

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

      return mapMessage(message);
    },
  );

  /** Deprecated: titles come from <atlarix-chat-summary> in the assistant reply. */
  handle("sessions:generate-title", async (_event, sessionId: string) => {
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session) throw new Error("Session not found");
    return { title: session.title };
  });
}
