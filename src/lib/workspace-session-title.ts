import { getDefaultStore } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { isLowQualityGeneratedTitle } from "@/utils/chat_naming";
import {
  workspaceSessionsRefreshAtom,
  workspaceSessionTitleGeneratingAtom,
} from "@/atoms/sessionAtoms";
import { updateOpenChatTabTitleForSession } from "@/lib/open-workspace-session";

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
  if (!raw || isLowQualityGeneratedTitle(raw)) return null;
  return raw.split(/\s+/).slice(0, 6).join(" ").slice(0, 80);
}

function setSessionTitleGenerating(sessionId: string, generating: boolean): void {
  const store = getDefaultStore();
  store.set(workspaceSessionTitleGeneratingAtom, (prev: Set<string>) => {
    const next = new Set(prev);
    if (generating) next.add(sessionId);
    else next.delete(sessionId);
    return next;
  });
}

/**
 * Chats whose title has already been generated this run.
 *
 * Module-level rather than a component ref because two places need it: the
 * stream hook (which generates after the first exchange) and the composer
 * (which must ALLOW a regeneration when the first prompt is edited). A ref in
 * one component is unreachable from the other.
 */
const titleGeneratedChats = new Set<number>();

/** True when this chat still needs a generated title. */
export function needsGeneratedTitle(chatId: number): boolean {
  return !titleGeneratedChats.has(chatId);
}

export function markTitleGenerated(chatId: number): void {
  titleGeneratedChats.add(chatId);
}

/**
 * The first prompt changed, so the title derived from it is stale — let the next
 * completed turn regenerate it.
 *
 * Only the FIRST exchange feeds the title, so only an edit to it should reopen
 * this; editing a later message leaves the title alone. A title the user typed
 * by hand is still protected downstream by `titleSource === "user"`.
 */
export function allowRetitleAfterFirstPromptEdit(chatId: number): void {
  titleGeneratedChats.delete(chatId);
}

/** Async AI title from first user + assistant messages after the first turn completes. */
export async function applyAIWorkspaceSessionTitle(sessionId: string): Promise<void> {
  setSessionTitleGenerating(sessionId, true);
  try {
    const { session } = await IpcClient.getInstance().getWorkspaceSession(sessionId);
    // Ownership, not "is it still Untitled". Re-deriving a title the USER typed
    // would be worse than never re-titling; re-deriving one we generated is the
    // whole point when the prompt it came from has changed.
    if (session.titleSource === "user") return;

    const { title } = await IpcClient.getInstance().generateWorkspaceSessionTitle(sessionId);
    if (
      title &&
      !isDefaultSessionTitle(title) &&
      !isLowQualityGeneratedTitle(title)
    ) {
      getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
      // v14.8.11: the tab strip holds a title SNAPSHOT — push the new name
      // into any open tab for this session or it stays "Untitled" forever.
      updateOpenChatTabTitleForSession(sessionId, title);
    }
  } catch (e) {
    console.error("Failed to apply AI workspace session title:", e);
  } finally {
    setSessionTitleGenerating(sessionId, false);
  }
}

