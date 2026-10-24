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
 * How a changed file is listed: as the workspace names it, `~/…` outside it
 * (it read "../../../../Users/…": 15.11.1 QA), and not at all inside the
 * agent's memory folder, its scratch space, not a change to your files.
 */
async function displayPath(workspacePath: string): Promise<(rel: string) => string | null> {
  const path = await import("node:path");
  const os = await import("node:os");
  const { memoryDirFor } = await import("@/lib/agent-memory");
  const memory = path.resolve(memoryDirFor(workspacePath));
  const home = os.homedir();
  return (rel) => {
    if (!rel.startsWith("../") && !path.isAbsolute(rel)) return rel;
    const abs = path.resolve(workspacePath, rel);
    if (abs === memory || abs.startsWith(memory + path.sep)) return null;
    if (abs.startsWith(home + path.sep)) return `~/${path.relative(home, abs).split(path.sep).join("/")}`;
    return abs.split(path.sep).join("/");
  };
}

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
    const shown = await displayPath(workspacePath);
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
    return [...changed].map(shown).filter((f): f is string => f != null).sort();
  } catch {
    return null;
  }
}
