import { getDefaultStore } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import {
  workspaceSessionsRefreshAtom,
  workspaceSessionTitleGeneratingAtom,
} from "@/atoms/sessionAtoms";

export const DEFAULT_SESSION_TITLE = "Untitled";

const DEFAULT_SESSION_TITLES = new Set([
  DEFAULT_SESSION_TITLE,
  "New session",
  "New chat",
]);

export function isDefaultSessionTitle(title: string): boolean {
  return DEFAULT_SESSION_TITLES.has(title.trim());
}

export function extractAtlarixChatSummary(content: string): string | null {
  const match = content.match(/<atlarix-chat-summary>([\s\S]*?)<\/atlarix-chat-summary>/);
  if (!match) return null;
  const raw = match[1].trim().replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  return raw.split(/\s+/).slice(0, 6).join(" ").slice(0, 80);
}

function setSessionTitleGenerating(sessionId: string, generating: boolean): void {
  const store = getDefaultStore();
  store.set(workspaceSessionTitleGeneratingAtom, (prev) => {
    const next = new Set(prev);
    if (generating) next.add(sessionId);
    else next.delete(sessionId);
    return next;
  });
}

/** Async AI title from first user + assistant messages after the first turn completes. */
export async function applyAIWorkspaceSessionTitle(sessionId: string): Promise<void> {
  setSessionTitleGenerating(sessionId, true);
  try {
    const { session } = await IpcClient.getInstance().getWorkspaceSession(sessionId);
    if (!isDefaultSessionTitle(session.title)) return;

    const { title } = await IpcClient.getInstance().generateWorkspaceSessionTitle(sessionId);
    if (title && !isDefaultSessionTitle(title)) {
      getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
    }
  } catch (e) {
    console.error("Failed to apply AI workspace session title:", e);
  } finally {
    setSessionTitleGenerating(sessionId, false);
  }
}

/** Fallback when summarization model is unavailable: scrape summary tag from assistant reply. */
export async function applyWorkspaceSessionTitleFromSummary(
  sessionId: string,
  assistantContent: string,
): Promise<void> {
  const title = extractAtlarixChatSummary(assistantContent);
  if (!title) return;
  try {
    const { session } = await IpcClient.getInstance().getWorkspaceSession(sessionId);
    if (!isDefaultSessionTitle(session.title)) return;
    await IpcClient.getInstance().renameWorkspaceSession(sessionId, title);
    getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
  } catch (e) {
    console.error("Failed to apply workspace session title from summary:", e);
  }
}
