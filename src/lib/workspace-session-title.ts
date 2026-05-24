import { getDefaultStore } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { workspaceSessionsRefreshAtom } from "@/atoms/sessionAtoms";
import { titleFromFirstUserMessage } from "@/lib/session-title";

export const DEFAULT_SESSION_TITLE = "Untitled";

const DEFAULT_SESSION_TITLES = new Set([
  DEFAULT_SESSION_TITLE,
  "New session",
  "New chat",
]);

export function extractAtlarixChatSummary(content: string): string | null {
  const match = content.match(/<atlarix-chat-summary>([\s\S]*?)<\/atlarix-chat-summary>/);
  if (!match) return null;
  const raw = match[1].trim().replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  return raw.split(/\s+/).slice(0, 6).join(" ").slice(0, 80);
}

/** Rename session from the first user message when the title is still a default. */
export async function applyInstantWorkspaceSessionTitle(
  sessionId: string,
  firstUserMessage: string,
): Promise<void> {
  const title = titleFromFirstUserMessage(firstUserMessage);
  if (DEFAULT_SESSION_TITLES.has(title)) return;
  try {
    const { session } = await IpcClient.getInstance().getWorkspaceSession(sessionId);
    if (!DEFAULT_SESSION_TITLES.has(session.title.trim())) return;
    await IpcClient.getInstance().renameWorkspaceSession(sessionId, title);
    getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
  } catch (e) {
    console.error("Failed to apply instant workspace session title:", e);
  }
}

/** Apply model-scraped session title once when the session still has a default name. */
export async function applyWorkspaceSessionTitleFromSummary(
  sessionId: string,
  assistantContent: string,
): Promise<void> {
  const title = extractAtlarixChatSummary(assistantContent);
  if (!title) return;
  try {
    const { session } = await IpcClient.getInstance().getWorkspaceSession(sessionId);
    if (!DEFAULT_SESSION_TITLES.has(session.title.trim())) return;
    await IpcClient.getInstance().renameWorkspaceSession(sessionId, title);
    getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
  } catch (e) {
    console.error("Failed to apply workspace session title from summary:", e);
  }
}
