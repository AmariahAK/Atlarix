/**
 * What a session's recent turns actually changed on disk, for its recap.
 *
 * The recap is written by a model from the conversation, so it repeated what
 * the conversation CLAIMED: after a denied edit re-routed through a writer
 * sub-agent, "updated ants.js", with nothing changed (15.11.0, filming). The
 * snapshot manifests are written only when a change really lands, so they are
 * what the recap is told.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { apps, chatSessions, sessionMessages } from "@/db/schema";

/** How many of the session's latest turns that changed something count. */
const RECENT_TURNS = 20;

/**
 * Files the session's recent turns changed (workspace-relative, "/"), minus
 * any a later revert put back. Null when it can't be known (no session or
 * workspace for the chat), so the recap is not told "none" by mistake.
 */
export async function recentChangedFiles(
  ref: { chatId: number } | { sessionId: string; workspacePath: string },
): Promise<string[] | null> {
  try {
    let sessionId: string;
    let workspacePath: string;
    if ("chatId" in ref) {
      const session = await db.query.chatSessions.findFirst({ where: eq(chatSessions.streamChatId, ref.chatId) });
      if (!session?.workspaceId) return null;
      const app = await db.query.apps.findFirst({ where: eq(apps.id, session.workspaceId) });
      if (!app?.path) return null;
      sessionId = session.id;
      workspacePath = app.path;
    } else {
      sessionId = ref.sessionId;
      workspacePath = ref.workspacePath;
    }
    const rows = await db
      .select({ turnId: sessionMessages.snapshotTurnId })
      .from(sessionMessages)
      .where(and(eq(sessionMessages.sessionId, sessionId), isNotNull(sessionMessages.snapshotTurnId)))
      .orderBy(desc(sessionMessages.createdAt))
      .limit(RECENT_TURNS);
    const { listSnapshotFiles } = await import("@/lib/snapshot/snapshot-manager");
    const changed = new Set<string>();
    for (const { turnId } of rows.reverse()) {
      if (!turnId) continue;
      const files = await listSnapshotFiles(workspacePath, turnId).catch(() => null);
      if (!files) continue;
      if (files.revertedAt) {
        for (const f of files.revertedFiles ?? files.filesChanged) changed.delete(f.replace(/\\/g, "/"));
        continue;
      }
      for (const f of files.filesChanged) changed.add(f.replace(/\\/g, "/"));
    }
    return [...changed].sort();
  } catch {
    return null;
  }
}
